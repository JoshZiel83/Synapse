import { randomUUID } from "crypto"
import {
  buildConversationMessageRef,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SCOPES,
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_SURFACES,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_ITEM_TYPES,
  CONVERSATION_KIND,
  CONVERSATION_KINDS,
  CONVERSATION_PARTICIPANT_TYPE,
  normalizeCanonicalContentBlocks,
  parseConversationMessageRef,
  extractText,
  type CanonicalContentBlock,
  type ActorRuntimeTurnActivityDetail,
  type ChatBootstrapResponse,
  type ChatClientInstanceRegistrationResponse,
  type ChatConversationEventItem,
  type ChatConversationCreateResponse,
  type ChatConversationItem,
  type ChatConversationMessagesPage,
  type ChatConversationReadWatermarkResponse,
  type ChatConversationSendMessageRequest,
  type ChatConversationSendMessageResponse,
  type ChatConversationView,
  type ChatDeviceState,
  type ChatParticipantSummary,
  type ChatSyncEvent,
  type ChatSyncEventPayloadMap,
  type ChatSyncEventType,
  type ChatSyncResponse,
  type Timestamp,
  type ConversationMessageSubtype,
  type ConversationParticipantType,
  type ConversationReplyRef,
  type SessionWakeupSourceParticipantType,
  isTransportKind,
} from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import type {
  ConversationEntityRef,
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
  ConversationFeedEventItem,
  ConversationFeedMessageType,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  ConversationFeedItem,
  ConversationFeedMessageItem,
  ConversationMessageTransportContext,
  ConversationMessageTransportDelivery,
  TaskSummary,
  TransportKind,
} from "@synapse/shared/types"
import { CompiledQuery, sql, type RawBuilder } from "kysely"
import type { JsonValue } from "../../infrastructure/database/generated/db.js"
import {
  db,
  runBuilder,
  withDbTransaction,
  type Executor,
  type DatabaseTransaction,
} from "../../infrastructure/database/kysely.js"
import { SUBJECT_KIND } from "@synapse/shared"
import {
  subjectKindToParticipantType,
  upsertAccessSubject,
  upsertAccessSubjectOn,
} from "../access/subject-registry.js"
import { enqueueTransactionalEvent } from "../../infrastructure/events/index.js"
import { getFileUrlById } from "../files/service.js"
import {
  buildNormalizedMessageContent,
  canonicalContentBlocksToDraftParts,
  itemPartsToCanonicalContentBlocks,
} from "./message-content.js"
import {
  parseInstantString,
  requireInstantDate,
  serializeInstant,
  serializeNowInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import {
  getConversationEventSpec,
  isConversationEventType,
  renderConversationEventTimelineBlocks,
} from "./event-registry.js"
import {
  recordDuplicateClientMessageIdSend,
  recordDuplicateWatermarkPost,
} from "./observability.js"
import {
  requireWorkspaceMemberIdentity,
  type WorkspaceMemberIdentity,
} from "./workspace-identity.js"
import { enrichTaskForUser } from "../tasks/service.js"
import {
  getConversationRuntimeMap,
  getSessionRuntimeTurnActivityDetail,
} from "../session/runtime.js"

export interface ChatServiceError extends Error {
  code: string
  statusCode: number
  details?: Record<string, unknown>
}

type ConversationKind = (typeof CONVERSATION_KINDS)[number]
type ParticipantKind = ConversationParticipantType
type ItemScope = (typeof CONVERSATION_ITEM_SCOPES)[number]
type ItemSurface = (typeof CONVERSATION_ITEM_SURFACES)[number]
type ItemType = (typeof CONVERSATION_ITEM_TYPES)[number]
type ItemRole = (typeof CONVERSATION_ITEM_ROLES)[number]
type NonEventItemType = Exclude<ItemType, "event">

export interface ConversationItemPartInput {
  type: "text" | "file_ref" | "json"
  text?: string
  refPath?: string | null
  refSha256?: string | null
  json?: unknown
  mimeType?: string
  name?: string
  metadata?: Record<string, unknown>
}

type ConversationBaseRow = {
  conversation_id: string
  kind: ConversationKind
  is_im: boolean
  title: string | null
  created_at: Date
  updated_at: Date
  unread_count: number | string
  muted: boolean
  archived: boolean
  pinned_sort_key: Date | null
  last_visible_item_id: string | null
  last_visible_sequence: number | string
  last_visible_at: Date | null
}

type ParticipantRow = {
  id: string
  conversation_id: string
  participant_type: ParticipantKind
  workspace_member_id: string | null
  actor_id: string | null
  remote_agent_id: string | null
  actor_join_version_id: string | null
  display_name: string | null
  role_key: string
  state: "active" | "left" | "removed"
  metadata: unknown
  joined_at: Date
  left_at: Date | null
  user_id: string | null
  user_name: string | null
  participant_name: string | null
  participant_title: string | null
  participant_role: string | null
  actor_docs: unknown
  actor_can_represent_user: boolean | null
  actor_specialties: unknown
  actor_config: unknown
  actor_current_version: number | string | null
  participant_avatar_emoji: string | null
  participant_avatar_file_id: string | null
  user_avatar_file_id: string | null
  transport_address_id: string | null
  transport_kind: string | null
  transport_external_id: string | null
  transport_display_name: string | null
  linked_user_id: string | null
  linked_user_name: string | null
  linked_user_avatar_file_id: string | null
  session_id: string | null
  session_status: string | null
}

type ItemRow = {
  id: string
  conversation_id: string
  session_id?: string | null
  turn_id?: string | null
  client_message_id: string | null
  scope: "shared" | "private"
  surface: "visible" | "internal"
  item_type: "message" | "event" | "summary" | "control"
  subtype: string
  role: "user" | "assistant" | "system" | "tool"
  author_participant_id: string | null
  reply_to_item_id: string | null
  caused_by_item_id: string | null
  event_payload?: unknown
  event_timeline_policy?: string | null
  event_context_policy?: string | null
  metadata: unknown
  sequence: string | number
  created_at: Date
}

type ItemPartRow = {
  item_id: string
  ordinal: number
  part_type: "text" | "file_ref" | "json"
  text_value: string | null
  ref_path: string | null
  ref_sha256: string | null
  json_value: unknown
  mime_type: string | null
  name: string | null
  metadata: unknown
}

type ParticipantLinkRow = {
  item_id: string
  target_participant_id: string
}

interface ConversationItemDetailBase {
  id: string
  conversationId: string
  sessionId?: string
  turnId?: string
  sequence: number
  scope: ItemScope
  surface: ItemSurface
  role: ItemRole
  authorParticipantId?: string
  authorParticipant?: ParticipantRow
  restrictedAudienceParticipants: ParticipantRow[]
  contextTargets: ParticipantRow[]
  contentBlocks: CanonicalContentBlock[]
  metadata: Record<string, unknown>
  replyToItemId?: string
  replyTo?: ConversationReplyRef
  causedByItemId?: string
  createdAt: Timestamp
  clientMessageId?: string
}

export interface ConversationNonEventItemDetail extends ConversationItemDetailBase {
  itemType: NonEventItemType
  subtype: ConversationFeedMessageType
}

export interface ConversationEventItemDetail<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> extends ConversationItemDetailBase {
  itemType: "event"
  subtype: T
  eventPayload: ConversationFeedEventPayloadMap[T]
  eventTimelinePolicy?: ConversationEventTimelinePolicy
  eventContextPolicy?: ConversationEventContextPolicy
}

export type ConversationItemDetail =
  | ConversationNonEventItemDetail
  | ConversationEventItemDetail

type HydratedConversationItemRecord = {
  id: string
  conversationId: string
  sequence: number
  clientMessageId?: string
  itemType: ItemType
  role: ItemRole
  subtype: string
  scope: ItemScope
  surface: ItemSurface
  authorParticipantId?: string
  replyToItemId?: string
  causedByItemId?: string
  content: string
  contentBlocks: CanonicalContentBlock[]
  metadata: Record<string, unknown>
  restrictedAudienceParticipantIds: string[]
  createdAt: Timestamp
}

type RegisterClientInstanceInput = {
  workspaceId: string
  workspaceMemberId: string
  platform?: string
  deviceLabel?: string
  metadata?: Record<string, unknown>
}

type UpdateClientInstanceInput = RegisterClientInstanceInput & {
  clientInstanceId: string
}

type SendMessageInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
} & ChatConversationSendMessageRequest

type ReadWatermarkInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
  clientInstanceId: string
  readUpToSequence: number
  lastVisibleSequence?: number
}

function createChatError(
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): ChatServiceError {
  const error = new Error(message) as ChatServiceError
  error.statusCode = statusCode
  error.code = code
  error.details = details
  return error
}

export function isChatServiceError(value: unknown): value is ChatServiceError {
  return Boolean(
    value &&
    typeof value === "object" &&
    "statusCode" in value &&
    "code" in value
  )
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }
  return {}
}

const CONVERSATION_MESSAGE_SUBTYPE_SET = new Set<ConversationMessageSubtype>([
  "chat.message",
  "user",
  "assistant",
  "system",
  "tool_result",
  "model_error_notice",
])

function isConversationMessageSubtype(
  value: string
): value is ConversationMessageSubtype {
  return CONVERSATION_MESSAGE_SUBTYPE_SET.has(
    value as ConversationMessageSubtype
  )
}

function assertConversationMessageSubtype(
  value: string
): asserts value is ConversationMessageSubtype {
  if (!isConversationMessageSubtype(value)) {
    throw new Error(`Unsupported conversation message subtype: ${value}`)
  }
}

function asConversationFeedEventPayload<T extends ConversationFeedEventType>(
  eventType: T,
  payload: unknown
): ConversationFeedEventPayloadMap[T] {
  return asJsonRecord(payload) as unknown as ConversationFeedEventPayloadMap[T]
}

function asChatSyncEventPayload<T extends ChatSyncEventType>(
  eventType: T,
  payload: unknown
): ChatSyncEventPayloadMap[T] {
  return asJsonRecord(payload) as unknown as ChatSyncEventPayloadMap[T]
}

async function enrichChatConversationItemForViewer(
  item: ChatConversationItem,
  userId: string
): Promise<ChatConversationItem> {
  if (item.itemType !== "event" || item.subtype !== "task_requested") {
    return item
  }

  const payload = item.eventPayload
  const task =
    payload && typeof payload === "object" && "task" in payload
      ? (payload as ConversationFeedEventPayloadMap["task_requested"]).task
      : undefined

  if (!task) {
    return item
  }

  return {
    ...item,
    eventPayload: {
      ...payload,
      task: await enrichTaskForUser(task as TaskSummary, userId),
    },
  } as ChatConversationItem
}

async function enrichChatConversationItemsForViewer(
  items: ChatConversationItem[],
  userId: string
) {
  const enriched = await Promise.all(
    items.map((item) => enrichChatConversationItemForViewer(item, userId))
  )
  return enriched
}

async function enrichChatSyncEventPayloadForViewer<T extends ChatSyncEventType>(
  eventType: T,
  payload: ChatSyncEventPayloadMap[T],
  userId: string
): Promise<ChatSyncEventPayloadMap[T]> {
  if (eventType === "conversation.item.created") {
    const eventPayload =
      payload as ChatSyncEventPayloadMap["conversation.item.created"]
    return {
      ...eventPayload,
      item: await enrichChatConversationItemForViewer(
        eventPayload.item,
        userId
      ),
    } as ChatSyncEventPayloadMap[T]
  }

  if (eventType === "task.updated") {
    const eventPayload = payload as ChatSyncEventPayloadMap["task.updated"]
    return {
      ...eventPayload,
      task: await enrichTaskForUser(eventPayload.task, userId),
    } as ChatSyncEventPayloadMap[T]
  }

  return payload
}

function asParticipantTransportKind(
  value: string | null | undefined
): ConversationEntityRef["transportKind"] {
  return isTransportKind(value) ? value : undefined
}

function participantDisplayName(row: ParticipantRow): string {
  if (row.participant_type === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER) {
    if (typeof row.user_name === "string" && row.user_name.trim()) {
      return row.user_name.trim()
    }
  }
  if (row.participant_type === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
    if (
      typeof row.participant_name === "string" &&
      row.participant_name.trim()
    ) {
      return row.participant_name.trim()
    }
  }
  if (row.participant_type === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT) {
    if (
      typeof row.participant_name === "string" &&
      row.participant_name.trim()
    ) {
      return row.participant_name.trim()
    }
  }
  if (
    row.participant_type === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
    typeof row.transport_display_name === "string" &&
    row.transport_display_name.trim()
  ) {
    return row.transport_display_name.trim()
  }
  if (
    row.participant_type === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
    typeof row.display_name === "string" &&
    row.display_name.trim()
  ) {
    return row.display_name.trim()
  }
  if (typeof row.linked_user_name === "string" && row.linked_user_name.trim()) {
    return row.linked_user_name.trim()
  }
  if (typeof row.user_name === "string" && row.user_name.trim()) {
    return row.user_name.trim()
  }
  if (typeof row.participant_name === "string" && row.participant_name.trim()) {
    return row.participant_name.trim()
  }
  if (typeof row.display_name === "string" && row.display_name.trim()) {
    return row.display_name.trim()
  }
  return "Unknown"
}

function participantAvatarUrl(row: ParticipantRow): string | undefined {
  const fileId =
    row.participant_avatar_file_id ??
    row.user_avatar_file_id ??
    row.linked_user_avatar_file_id
  return fileId ? getFileUrlById(fileId) : undefined
}

function participantAvatarEmoji(row: ParticipantRow): string | undefined {
  return row.participant_avatar_emoji ?? undefined
}

function previewTextFromItem(item: ChatConversationItem | undefined): string {
  if (!item) return ""
  const text = item.content.trim() || extractText(item.contentBlocks).trim()
  if (text) return text
  return item.itemType === "message" ? "Attachment" : `[${item.subtype}]`
}

function computeConversationTitle(params: {
  baseTitle: string | null
  kind: ConversationKind
  participants: ChatParticipantSummary[]
  viewerWorkspaceMemberId: string
}): string {
  const baseTitle =
    typeof params.baseTitle === "string" ? params.baseTitle.trim() : ""
  if (baseTitle) {
    return baseTitle
  }

  const active = params.participants.filter(
    (participant) => participant.state === "active"
  )
  const labels =
    params.kind === CONVERSATION_KIND.DIRECT
      ? active
          .filter(
            (participant) =>
              !(
                participant.participantType ===
                  CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
                participant.workspaceMemberId === params.viewerWorkspaceMemberId
              )
          )
          .map((participant) => participant.name)
      : active.map((participant) => participant.name)

  const uniqueLabels = [...new Set(labels.filter(Boolean))]
  if (uniqueLabels.length === 0) {
    return params.kind === CONVERSATION_KIND.DIRECT
      ? "Direct message"
      : "Untitled conversation"
  }
  if (uniqueLabels.length <= 3) {
    return uniqueLabels.join(", ")
  }
  return `${uniqueLabels.slice(0, 3).join(", ")} +${uniqueLabels.length - 3}`
}

function buildConversationPresentation(params: {
  kind: ConversationKind
  isIm: boolean
  participants: ChatParticipantSummary[]
  viewerWorkspaceMemberId: string
}) {
  const activeParticipants = params.participants.filter(
    (participant) => participant.state === "active"
  )
  const peer =
    params.kind === CONVERSATION_KIND.DIRECT
      ? (activeParticipants.find(
          (participant) =>
            !(
              participant.participantType ===
                CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
              participant.workspaceMemberId === params.viewerWorkspaceMemberId
            )
        ) ?? activeParticipants[0])
      : undefined
  const avatarParticipants =
    params.kind === CONVERSATION_KIND.DIRECT
      ? peer
        ? [peer]
        : activeParticipants.slice(0, 1)
      : activeParticipants.slice(0, 4)
  const isDirect = params.kind === CONVERSATION_KIND.DIRECT

  return {
    chatType: isDirect ? "direct" : "group",
    subtitle: params.isIm
      ? isDirect
        ? "IM direct chat"
        : "IM group chat"
      : isDirect
        ? "Direct message"
        : "Group chat",
    avatarParticipantIds: avatarParticipants.map(
      (participant) => participant.participantId
    ),
    peerParticipantId: peer?.participantId,
    avatarUrl: peer?.avatarUrl,
    avatarEmoji: peer?.avatarEmoji,
  } satisfies ChatConversationView["presentation"]
}

function isUniqueViolation(error: unknown) {
  const candidate = error as { code?: string } | null
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    candidate.code === "23505"
  )
}

function rootQueryable(): Executor {
  return db
}

/**
 * Run a raw SQL statement (text + positional params) on either the top-level
 * `db` or a transaction `trx` — the chat module's raw-SQL execution path.
 * Routes through Kysely's `CompiledQuery.raw`.
 */
async function runOn<T extends object = Record<string, unknown>>(
  executor: Executor,
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  const result = await executor.executeQuery<T>(
    CompiledQuery.raw(text, [...params])
  )
  return { rows: result.rows as T[] }
}

/** `runOn` bound to the top-level `db` (replaces the old pool-scoped executeSql). */
function runOnDb<T extends object = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return runOn<T>(db, text, params)
}

/** Serialize a value into a jsonb-typed SQL fragment (matches `$N::jsonb`). */
function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value ?? null)}::jsonb`
}

async function getWorkspaceMemberIdentityOrThrow(
  workspaceId: string,
  userId: string
) {
  try {
    return await requireWorkspaceMemberIdentity(workspaceId, userId)
  } catch {
    throw createChatError(
      403,
      "workspace_access_denied",
      "You are not a member of this workspace"
    )
  }
}

async function ensureClientInstance(
  queryable: Executor,
  input: UpdateClientInstanceInput
) {
  const existing = await runBuilder(
    queryable,
    queryable
      .selectFrom("chat_client_instances")
      .select(["workspace_id", "workspace_member_id"])
      .where("id", "=", input.clientInstanceId)
      .limit(1)
  )
  const owner = existing.rows[0]
  if (!owner) {
    throw createChatError(
      404,
      "client_instance_not_found",
      "Client instance not found"
    )
  }
  if (
    owner.workspace_id !== input.workspaceId ||
    owner.workspace_member_id !== input.workspaceMemberId
  ) {
    throw createChatError(
      403,
      "client_instance_forbidden",
      "Client instance belongs to another workspace member"
    )
  }
}

async function createClientInstance(
  queryable: Executor,
  input: RegisterClientInstanceInput
) {
  const clientInstanceId = randomUUID()
  await queryable
    .insertInto("chat_client_instances")
    .values({
      id: clientInstanceId,
      workspace_id: input.workspaceId,
      workspace_member_id: input.workspaceMemberId,
      platform: input.platform ?? null,
      device_label: input.deviceLabel ?? null,
      status: "active",
      metadata: jsonbValue(input.metadata ?? {}),
      last_seen_at: sql`NOW()`,
      created_at: sql`NOW()`,
    })
    .execute()

  return clientInstanceId
}

async function touchClientInstance(
  queryable: Executor,
  input: UpdateClientInstanceInput
) {
  await ensureClientInstance(queryable, input)

  await queryable
    .updateTable("chat_client_instances")
    .set({
      platform: sql`COALESCE(${input.platform ?? null}, platform)`,
      device_label: sql`COALESCE(${input.deviceLabel ?? null}, device_label)`,
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${jsonbValue(
        input.metadata ?? {}
      )}`,
      status: "active",
      last_seen_at: sql`NOW()`,
    })
    .where("id", "=", input.clientInstanceId)
    .execute()
}

async function listConversationParticipantRows(
  queryable: Executor,
  conversationIds: string[],
  options?: { useProfileSnapshot?: boolean }
) {
  if (conversationIds.length === 0) {
    return [] as ParticipantRow[]
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

  const result = await runOn<ParticipantRow>(
    queryable,
    `
      SELECT
        cp.id,
        cp.conversation_id,
        cpsubj.kind AS participant_type,
        cpsubj.workspace_member_id AS workspace_member_id,
        cpsubj.actor_id AS actor_id,
        cpsubj.remote_agent_id AS remote_agent_id,
        cp.actor_join_version_id,
        cp.display_name,
        cp.role_key,
        cp.state,
        cp.metadata,
        cp.joined_at,
        cp.left_at,
        wm.user_id,
        u.name AS user_name,
        ${participantDisplayNameExpr} AS participant_name,
        ${participantTitleExpr} AS participant_title,
        ${participantRoleExpr} AS participant_role,
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
        END AS actor_docs,
        ${participantCanRepresentExpr} AS actor_can_represent_user,
        ${participantSpecialtiesExpr} AS actor_specialties,
        ${participantConfigExpr} AS actor_config,
        ${participantCurrentVersionExpr} AS actor_current_version,
        a.avatar_emoji AS participant_avatar_emoji,
        a.avatar_file_id AS participant_avatar_file_id,
        u.avatar_file_id AS user_avatar_file_id,
        primary_address.id AS transport_address_id,
        primary_address.transport_kind,
        primary_address.external_id AS transport_external_id,
        primary_address.display_name AS transport_display_name,
        primary_address.linked_user_id,
        linked_user.name AS linked_user_name,
        linked_user.avatar_file_id AS linked_user_avatar_file_id,
        ls.id AS session_id,
        COALESCE(ls.status::text, rab.runtime_state::text) AS session_status
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

  return result.rows
}

async function getWorkspaceMemberConversationParticipantRow(
  queryable: Executor,
  conversationId: string,
  workspaceMemberId: string
) {
  const result = await runOn<ParticipantRow>(
    queryable,
    `
      SELECT
        cp.id,
        cp.conversation_id,
        cpsubj.kind AS participant_type,
        cpsubj.workspace_member_id AS workspace_member_id,
        cpsubj.actor_id AS actor_id,
        cpsubj.remote_agent_id AS remote_agent_id,
        cp.actor_join_version_id,
        cp.display_name,
        cp.role_key,
        cp.state,
        cp.metadata,
        cp.joined_at,
        cp.left_at,
        wm.user_id,
        u.name AS user_name,
        COALESCE(remote_agent_app.display_name, actor_app.display_name) AS participant_name,
        COALESCE(ra.title, a.title) AS participant_title,
        COALESCE(CASE WHEN ra.id IS NOT NULL THEN 'remote_agent' END, a.role::text) AS participant_role,
        '[]'::jsonb AS actor_docs,
        a.can_represent_user AS actor_can_represent_user,
        a.specialties AS actor_specialties,
        a.config AS actor_config,
        a.current_version AS actor_current_version,
        COALESCE(ra.avatar_emoji, a.avatar_emoji) AS participant_avatar_emoji,
        COALESCE(ra.avatar_file_id, a.avatar_file_id) AS participant_avatar_file_id,
        u.avatar_file_id AS user_avatar_file_id,
        primary_address.id AS transport_address_id,
        primary_address.transport_kind,
        primary_address.external_id AS transport_external_id,
        primary_address.display_name AS transport_display_name,
        primary_address.linked_user_id,
        linked_user.name AS linked_user_name,
        linked_user.avatar_file_id AS linked_user_avatar_file_id,
        ls.id AS session_id,
        COALESCE(ls.status::text, rab.runtime_state::text) AS session_status
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
    [conversationId, workspaceMemberId]
  )

  return result.rows[0] ?? null
}

async function getConversationBaseRow(
  queryable: Executor,
  workspaceMemberId: string,
  conversationId: string
) {
  const result = await runOn<ConversationBaseRow>(
    queryable,
    `
      SELECT
        c.id AS conversation_id,
        c.kind,
        EXISTS (
          SELECT 1 FROM conversation_transport_bindings b
          WHERE b.conversation_id = c.id
        ) AS is_im,
        c.title,
        c.created_at,
        c.updated_at,
        v.unread_count,
        v.muted,
        v.archived,
        v.pinned_sort_key,
        v.last_visible_item_id,
        v.last_visible_sequence,
        v.last_visible_at
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
    [workspaceMemberId, conversationId]
  )

  return result.rows[0] ?? null
}

async function listConversationBaseRows(
  queryable: Executor,
  workspaceMemberId: string
) {
  const result = await runOn<ConversationBaseRow>(
    queryable,
    `
      SELECT
        c.id AS conversation_id,
        c.kind,
        EXISTS (
          SELECT 1 FROM conversation_transport_bindings b
          WHERE b.conversation_id = c.id
        ) AS is_im,
        c.title,
        c.created_at,
        c.updated_at,
        v.unread_count,
        v.muted,
        v.archived,
        v.pinned_sort_key,
        v.last_visible_item_id,
        v.last_visible_sequence,
        v.last_visible_at
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

async function listItemRowsByIds(queryable: Executor, itemIds: string[]) {
  if (itemIds.length === 0) {
    return [] as ItemRow[]
  }

  const result = await runOn<ItemRow>(
    queryable,
    `
      SELECT
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
        reply_to_item_id,
        caused_by_item_id,
        event_payload,
        event_timeline_policy,
        event_context_policy,
        metadata,
        sequence,
        created_at
      FROM conversation_items
      WHERE id = ANY($1::uuid[])
    `,
    [itemIds]
  )

  return result.rows
}

async function hydrateConversationItems(
  queryable: Executor,
  itemRows: ItemRow[]
) {
  if (itemRows.length === 0) {
    return [] as HydratedConversationItemRecord[]
  }

  const itemIds = itemRows.map((row) => row.id)
  const [partsResult, restrictedAudienceResult] = await Promise.all([
    runOn<ItemPartRow>(
      queryable,
      `
        SELECT
          item_id,
          ordinal,
          part_type,
          text_value,
          ref_path,
          ref_sha256,
          json_value,
          mime_type,
          name,
          metadata
        FROM conversation_item_parts
        WHERE item_id = ANY($1::uuid[])
        ORDER BY item_id ASC, ordinal ASC
      `,
      [itemIds]
    ),
    runOn<ParticipantLinkRow>(
      queryable,
      `
        SELECT item_id, target_participant_id
        FROM conversation_item_targets
        WHERE item_id = ANY($1::uuid[])
        ORDER BY item_id ASC, target_participant_id ASC
      `,
      [itemIds]
    ),
  ])

  const partsByItem = new Map<string, ItemPartRow[]>()
  for (const row of partsResult.rows) {
    const current = partsByItem.get(row.item_id) ?? []
    current.push(row)
    partsByItem.set(row.item_id, current)
  }

  const restrictedAudienceByItem = new Map<string, string[]>()
  for (const row of restrictedAudienceResult.rows) {
    const current = restrictedAudienceByItem.get(row.item_id) ?? []
    current.push(row.target_participant_id)
    restrictedAudienceByItem.set(row.item_id, current)
  }

  const itemMap = new Map<string, HydratedConversationItemRecord>()
  for (const row of itemRows) {
    const contentBlocks = itemPartsToCanonicalContentBlocks(
      (partsByItem.get(row.id) ?? []) as Parameters<
        typeof itemPartsToCanonicalContentBlocks
      >[0]
    )
    itemMap.set(row.id, {
      id: row.id,
      conversationId: row.conversation_id,
      sequence: toNumber(row.sequence),
      clientMessageId: row.client_message_id ?? undefined,
      itemType: row.item_type,
      role: row.role,
      subtype: row.subtype,
      scope: row.scope,
      surface: row.surface,
      authorParticipantId: row.author_participant_id ?? undefined,
      replyToItemId: row.reply_to_item_id ?? undefined,
      causedByItemId: row.caused_by_item_id ?? undefined,
      content: extractText(contentBlocks),
      contentBlocks,
      metadata: asJsonRecord(row.metadata),
      restrictedAudienceParticipantIds:
        restrictedAudienceByItem.get(row.id) ?? [],
      createdAt: serializeInstant(row.created_at),
    })
  }

  return itemRows.map((row) => itemMap.get(row.id)!).filter(Boolean)
}

async function loadConversationViews(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationIds?: string[]
) {
  const baseRows = conversationIds
    ? await Promise.all(
        conversationIds.map((conversationId) =>
          getConversationBaseRow(queryable, workspaceMemberId, conversationId)
        )
      ).then((rows) => rows.filter(Boolean) as ConversationBaseRow[])
    : await listConversationBaseRows(queryable, workspaceMemberId)

  if (baseRows.length === 0) {
    return [] as ChatConversationView[]
  }

  const ids = baseRows.map((row) => row.conversation_id)
  const participants = await listConversationParticipantRows(queryable, ids)
  const participantsByConversation = new Map<string, ParticipantRow[]>()
  for (const row of participants) {
    const current = participantsByConversation.get(row.conversation_id) ?? []
    current.push(row)
    participantsByConversation.set(row.conversation_id, current)
  }

  const lastItemIds = baseRows
    .map((row) => row.last_visible_item_id)
    .filter((value): value is string => Boolean(value))
  const lastItemRows = await listItemRowsByIds(queryable, [
    ...new Set(lastItemIds),
  ])
  const lastItems = await buildChatConversationItems(queryable, lastItemRows)
  const lastItemById = new Map(lastItems.map((item) => [item.id, item]))

  return baseRows.map((row) => {
    const conversationParticipants =
      participantsByConversation.get(row.conversation_id) ?? []
    const mappedParticipants = conversationParticipants.map(
      participantRowToChatParticipantSummary
    )
    const viewerMembership = conversationParticipants.find(
      (participant) =>
        participant.state === "active" &&
        participant.participant_type ===
          CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
        participant.workspace_member_id === workspaceMemberId
    )
    const viewerConversationRole =
      viewerMembership?.role_key === "owner" ||
      viewerMembership?.role_key === "admin" ||
      viewerMembership?.role_key === "member"
        ? viewerMembership.role_key
        : "member"
    const canManageConversation =
      row.kind !== CONVERSATION_KIND.DIRECT &&
      (viewerConversationRole === "owner" || viewerConversationRole === "admin")
    const canRename =
      row.kind !== CONVERSATION_KIND.DIRECT && canManageConversation
    const canManageParticipants = canManageConversation
    const status = conversationParticipants.some(
      (participant) =>
        participant.actor_id && participant.session_status !== "closed"
    )
      ? "active"
      : "completed"
    const title = computeConversationTitle({
      baseTitle: row.title,
      kind: row.kind,
      participants: mappedParticipants,
      viewerWorkspaceMemberId: workspaceMemberId,
    })
    const presentation = buildConversationPresentation({
      kind: row.kind,
      isIm: row.is_im,
      participants: mappedParticipants,
      viewerWorkspaceMemberId: workspaceMemberId,
    })
    const lastItem = row.last_visible_item_id
      ? lastItemById.get(row.last_visible_item_id)
      : undefined
    return {
      conversationId: row.conversation_id,
      workspaceId,
      title,
      kind: row.kind,
      isIm: row.is_im,
      status,
      unreadCount: toNumber(row.unread_count),
      muted: Boolean(row.muted),
      archived: Boolean(row.archived),
      pinnedSortKey: row.pinned_sort_key
        ? serializeInstant(row.pinned_sort_key)
        : undefined,
      updatedAt: serializeInstant(row.updated_at),
      createdAt: serializeInstant(row.created_at),
      participants: mappedParticipants,
      presentation,
      permissions: {
        canManageConversation,
        canManageParticipants,
        canRename,
      },
      viewerParticipantId: viewerMembership?.id,
      lastItem: lastItem
        ? {
            itemId: lastItem.id,
            sequence: lastItem.sequence,
            itemType: lastItem.itemType,
            subtype: lastItem.subtype,
            previewText: previewTextFromItem(lastItem),
            authorParticipantId: lastItem.authorParticipantId,
            author: lastItem.author,
            createdAt: lastItem.createdAt,
          }
        : undefined,
    } satisfies ChatConversationView
  })
}

async function loadConversationView(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationId: string
) {
  const views = await loadConversationViews(
    queryable,
    workspaceId,
    workspaceMemberId,
    [conversationId]
  )
  return views[0] ?? null
}

async function getCurrentSyncCursor(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string
) {
  // member_seq is the authoritative client cursor (see getChatSync).
  const result = await runOn<{ cursor: string | number }>(
    queryable,
    `
      SELECT COALESCE(MAX(member_seq), 0) AS cursor
      FROM workspace_member_sync_events
      WHERE workspace_id = $1
        AND workspace_member_id = $2
    `,
    [workspaceId, workspaceMemberId]
  )
  return toNumber(result.rows[0]?.cursor)
}

async function countUnreadVisibleMessages(
  queryable: Executor,
  conversationId: string,
  participantId: string
) {
  const result = await runOn<{ unread_count: string | number }>(
    queryable,
    `
      SELECT COUNT(*)::int AS unread_count
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
    [conversationId, participantId]
  )

  return toNumber(result.rows[0]?.unread_count)
}

async function syncVisibleSharedItem(params: {
  queryable: Executor
  workspaceId?: string
  conversationId: string
  item: ChatConversationItem
  activeParticipants: ParticipantRow[]
  authorParticipantId?: string
  restrictedAudienceParticipantIds?: string[]
}) {
  const effectiveVisibleParticipantIds =
    params.restrictedAudienceParticipantIds &&
    params.restrictedAudienceParticipantIds.length > 0
      ? [
          ...new Set([
            ...params.restrictedAudienceParticipantIds,
            ...(params.authorParticipantId ? [params.authorParticipantId] : []),
          ]),
        ]
      : params.activeParticipants.map((participant) => participant.id)

  const visibleHumanParticipants = params.activeParticipants.filter(
    (participant) =>
      participant.workspace_member_id &&
      effectiveVisibleParticipantIds.includes(participant.id)
  )

  for (const participant of visibleHumanParticipants) {
    const unreadCount = await countUnreadVisibleMessages(
      params.queryable,
      params.conversationId,
      participant.id
    )
    await upsertConversationView(params.queryable, {
      workspaceMemberId: participant.workspace_member_id!,
      conversationId: params.conversationId,
      lastVisibleItemId: params.item.id,
      lastVisibleSequence: params.item.sequence,
      lastVisibleAt: params.item.createdAt,
      unreadCount,
      summary: {
        previewText: previewTextFromItem(params.item),
      },
    })
  }

  if (params.workspaceId) {
    for (const participant of visibleHumanParticipants) {
      await appendWorkspaceMemberSyncEvent(params.queryable, {
        workspaceId: params.workspaceId,
        workspaceMemberId: participant.workspace_member_id!,
        conversationId: params.conversationId,
        itemId: params.item.id,
        eventType: "conversation.item.created",
        payload: {
          conversationId: params.conversationId,
          item: params.item,
        },
      })
    }

    await syncConversationUpsertForWorkspaceMembers(
      params.queryable,
      params.workspaceId,
      visibleHumanParticipants
        .map((participant) => participant.workspace_member_id)
        .filter((value): value is string => Boolean(value)),
      params.conversationId
    )
  }
}

async function upsertConversationView(
  queryable: Executor,
  params: {
    workspaceMemberId: string
    conversationId: string
    lastVisibleItemId?: string | null
    lastVisibleSequence?: number
    lastVisibleAt?: string
    unreadCount: number
    summary?: Record<string, unknown>
  }
) {
  await queryable
    .insertInto("workspace_member_conversation_views")
    .values({
      workspace_member_id: params.workspaceMemberId,
      conversation_id: params.conversationId,
      last_visible_item_id: params.lastVisibleItemId ?? null,
      last_visible_sequence: params.lastVisibleSequence ?? 0,
      last_visible_at: params.lastVisibleAt
        ? parseInstantString(params.lastVisibleAt)
        : null,
      unread_count: params.unreadCount,
      summary: jsonbValue(params.summary ?? {}),
      created_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["workspace_member_id", "conversation_id"]).doUpdateSet({
        last_visible_item_id: sql`COALESCE(EXCLUDED.last_visible_item_id, workspace_member_conversation_views.last_visible_item_id)`,
        last_visible_sequence: sql`GREATEST(workspace_member_conversation_views.last_visible_sequence, EXCLUDED.last_visible_sequence)`,
        last_visible_at: sql`COALESCE(EXCLUDED.last_visible_at, workspace_member_conversation_views.last_visible_at)`,
        unread_count: sql`EXCLUDED.unread_count`,
        summary: sql`COALESCE(workspace_member_conversation_views.summary, '{}'::jsonb) || EXCLUDED.summary`,
      })
    )
    .execute()
}

/**
 * Discriminate a Kysely transaction from the top-level `db`. Kysely exposes
 * `isTransaction` on the instance (true only for a Transaction<DB>); used by the
 * sync-append wrapper to decide whether to reuse the caller's tx or open one.
 */
function isDatabaseTransaction(
  executor: Executor
): executor is DatabaseTransaction {
  return (executor as { isTransaction?: boolean }).isTransaction === true
}

/**
 * Append one durable sync event for a single workspace member, assigning the
 * per-member, commit-ordered, gap-free `member_seq` cursor.
 *
 * MUST run inside a transaction (the caller's `trx`): it takes a 64-bit
 * advisory transaction lock keyed on the member id, reads `MAX(member_seq)+1`,
 * and inserts the sync row + the realtime outbox row atomically. The advisory
 * lock serializes all concurrent appends for the same member, so the commit
 * order equals the `member_seq` order with no holes — which is exactly what the
 * client cursor (`getChatSync` paging by `member_seq > cursor`) relies on.
 *
 * Exported because external producers (tasks, remote-agents) append from
 * inside their OWN business transaction and must keep the domain write + sync +
 * outbox atomic; they call this directly with their `trx`. Bare-`db` callers go
 * through the `appendWorkspaceMemberSyncEvent` wrapper, which opens a tx.
 */
export async function appendWorkspaceMemberSyncEventInTransaction<
  T extends ChatSyncEventType,
>(
  trx: DatabaseTransaction,
  params: {
    workspaceId: string
    workspaceMemberId: string
    conversationId?: string
    itemId?: string
    eventType: T
    payload: ChatSyncEventPayloadMap[T]
  }
) {
  // Serialize concurrent appends for THIS member. hashtextextended yields a
  // stable 64-bit key (avoids the 32-bit hashtext collision space that would
  // make unrelated members block each other). The lock auto-releases at
  // commit/rollback (pg_advisory_xact_lock).
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${params.workspaceMemberId}, 0))`.execute(
    trx
  )

  const inserted = await runBuilder(
    trx,
    trx
      .insertInto("workspace_member_sync_events")
      .values({
        // member_seq = (current max for this member) + 1, computed under the
        // advisory lock above so it is contiguous and commit-ordered.
        member_seq: sql<number>`(
          SELECT COALESCE(MAX(member_seq), 0) + 1
          FROM workspace_member_sync_events
          WHERE workspace_member_id = ${params.workspaceMemberId}
        )`,
        workspace_id: params.workspaceId,
        workspace_member_id: params.workspaceMemberId,
        conversation_id: params.conversationId ?? null,
        item_id: params.itemId ?? null,
        event_type: params.eventType,
        payload: jsonbValue(params.payload),
        occurred_at: sql`NOW()`,
        created_at: sql`NOW()`,
      })
      .returning(["sync_seq", "member_seq", "occurred_at"])
  )

  const row = inserted.rows[0]
  const envelope: ChatSyncEvent<T> = {
    syncSeq: toNumber(row?.sync_seq),
    memberSeq: toNumber(row?.member_seq),
    workspaceId: params.workspaceId,
    workspaceMemberId: params.workspaceMemberId,
    conversationId: params.conversationId,
    itemId: params.itemId,
    eventType: params.eventType,
    payload: params.payload,
    occurredAt: serializeInstant(
      requireInstantDate(
        row?.occurred_at ?? null,
        "workspace_member_sync_events.occurred_at"
      )
    ),
  }

  await enqueueTransactionalEvent(trx, {
    type: "chat.sync.event",
    workspaceId: params.workspaceId,
    recipientWorkspaceMemberId: params.workspaceMemberId,
    payload: envelope as unknown as Record<string, unknown>,
    timestamp: envelope.occurredAt,
  })

  return envelope
}

/**
 * Transaction-aware append wrapper. If the caller already holds a transaction
 * (`queryable` is a Kysely transaction), reuse it so the domain write + sync +
 * outbox stay atomic. If the caller passes the bare `db` (autocommit), open a
 * transaction here — the advisory-lock-protected `MAX(member_seq)+1` MUST live
 * inside a transaction or the lock would release at statement end and the
 * counter could race.
 */
export async function appendWorkspaceMemberSyncEvent<
  T extends ChatSyncEventType,
>(
  queryable: Executor,
  params: {
    workspaceId: string
    workspaceMemberId: string
    conversationId?: string
    itemId?: string
    eventType: T
    payload: ChatSyncEventPayloadMap[T]
  }
) {
  if (isDatabaseTransaction(queryable)) {
    return appendWorkspaceMemberSyncEventInTransaction(queryable, params)
  }
  return withDbTransaction((trx) =>
    appendWorkspaceMemberSyncEventInTransaction(trx, params)
  )
}

async function getConversationSequenceMax(
  queryable: Executor,
  conversationId: string
) {
  const result = await runBuilder(
    queryable,
    queryable
      .selectFrom("conversation_items")
      .select((eb) => eb.fn.max("sequence").as("max_sequence"))
      .where("conversation_id", "=", conversationId)
  )

  return toNumber(result.rows[0]?.max_sequence)
}

async function getLastItemAtOrBeforeSequence(
  queryable: Executor,
  conversationId: string,
  sequence: number
) {
  const result = await runBuilder(
    queryable,
    queryable
      .selectFrom("conversation_items")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("sequence", "<=", String(sequence))
      .orderBy("sequence", "desc")
      .limit(1)
  )
  return result.rows[0]?.id ?? null
}

async function requireConversationAccess(
  queryable: Executor,
  conversationId: string,
  workspaceMemberId: string
) {
  const participant = await getWorkspaceMemberConversationParticipantRow(
    queryable,
    conversationId,
    workspaceMemberId
  )
  if (!participant || participant.state !== "active") {
    throw createChatError(
      403,
      "conversation_access_denied",
      "You are not a participant in this conversation"
    )
  }

  const baseRow = await getConversationBaseRow(
    queryable,
    workspaceMemberId,
    conversationId
  )
  if (!baseRow) {
    throw createChatError(
      404,
      "conversation_not_found",
      "Conversation not found"
    )
  }

  return {
    participant,
    baseRow,
  }
}

/**
 * Same as requireConversationAccess + asserts the viewer has management
 * rights (kind != "direct" AND role_key in ('owner','admin')). Throws
 * 403 conversation_manage_denied otherwise. Used by PATCH conversation,
 * POST participants, DELETE participants.
 */
async function requireConversationManagement(
  queryable: Executor,
  conversationId: string,
  workspaceMemberId: string
) {
  const access = await requireConversationAccess(
    queryable,
    conversationId,
    workspaceMemberId
  )
  if (access.baseRow.kind === CONVERSATION_KIND.DIRECT) {
    throw createChatError(
      403,
      "conversation_manage_denied",
      "Direct conversations cannot be managed"
    )
  }
  const roleKey = access.participant.role_key
  if (roleKey !== "owner" && roleKey !== "admin") {
    throw createChatError(
      403,
      "conversation_manage_denied",
      "Only conversation owners or admins can perform this action"
    )
  }
  return access
}

type PendingActorWakeup = {
  actorId: string
  sessionId: string
  sourceType: "user_message" | "actor_message"
}

type MentionedParticipantRef = {
  participantId: string
  ordinal: number
}

type PreparedConversationItemWrite = {
  activeParticipants: ParticipantRow[]
  parts: ConversationItemPartInput[]
  mentionedParticipants: MentionedParticipantRef[]
  replyToItem: ItemRow | null
}

function parseMentionBlockFromPart(part: ConversationItemPartInput) {
  if (part.type !== "json" || !part.json) {
    return null
  }
  const normalized = normalizeCanonicalContentBlocks([part.json as any])
  const block = normalized[0]
  return block?.type === "mention" ? block : null
}

function resolveMentionedConversationParticipant(
  participants: ParticipantRow[],
  mention: ConversationEntityRef
) {
  const activeParticipants = participants.filter(
    (participant) => participant.state === "active"
  )
  if (mention.participantId) {
    return activeParticipants.find(
      (participant) => participant.id === mention.participantId
    )
  }
  if (mention.workspaceMemberId) {
    return activeParticipants.find(
      (participant) =>
        participant.workspace_member_id === mention.workspaceMemberId
    )
  }
  if (mention.actorId) {
    return activeParticipants.find(
      (participant) => participant.actor_id === mention.actorId
    )
  }
  if (mention.externalUserKey) {
    return activeParticipants.find(
      (participant) =>
        participantRowToEntityRef(participant)?.externalUserKey ===
        mention.externalUserKey
    )
  }
  return null
}

async function canonicalizeConversationItemParts(
  queryable: Executor,
  params: {
    conversationId: string
    parts?: ConversationItemPartInput[]
    activeParticipants?: ParticipantRow[]
  }
): Promise<{
  parts: ConversationItemPartInput[]
  mentionedParticipants: MentionedParticipantRef[]
}> {
  const originalParts = params.parts ?? []
  if (originalParts.length === 0) {
    return {
      parts: [],
      mentionedParticipants: [],
    }
  }
  const participants =
    params.activeParticipants ??
    (
      await listConversationParticipantRows(
        queryable,
        [params.conversationId],
        {
          useProfileSnapshot: true,
        }
      )
    ).filter((participant) => participant.state === "active")
  const parts: ConversationItemPartInput[] = []
  const mentionedParticipants: MentionedParticipantRef[] = []

  for (const [ordinal, part] of originalParts.entries()) {
    const mentionBlock = parseMentionBlockFromPart(part)
    if (!mentionBlock) {
      parts.push(part)
      continue
    }

    const participant = resolveMentionedConversationParticipant(
      participants,
      mentionBlock.mention
    )
    if (!participant) {
      throw createChatError(
        400,
        "invalid_mention",
        "One or more mentions are invalid for this conversation"
      )
    }
    const canonicalMention = {
      ...mentionBlock,
      mention: participantRowToEntityRef(participant)!,
    }
    mentionedParticipants.push({
      participantId: participant.id,
      ordinal,
    })
    parts.push({
      ...part,
      json: canonicalMention,
      metadata: {
        ...(part.metadata ?? {}),
        mention: canonicalMention.mention,
      },
    })
  }

  return {
    parts,
    mentionedParticipants,
  }
}

async function validateConversationReplyTarget(
  queryable: Executor,
  conversationId: string,
  replyToItemId?: string,
  authorParticipantId?: string
) {
  if (!replyToItemId) {
    return null
  }
  const rows = await runOn<ItemRow>(
    queryable,
    `
      SELECT
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
        reply_to_item_id,
        caused_by_item_id,
        event_payload,
        event_timeline_policy,
        event_context_policy,
        metadata,
        sequence,
        created_at
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
    [replyToItemId, conversationId, authorParticipantId ?? null]
  )
  const row = rows.rows[0] ?? null
  if (!row) {
    throw createChatError(
      400,
      "invalid_reply_to_item",
      "replyToItemId must reference a visible item in the same conversation"
    )
  }
  return row
}

export async function resolveConversationReplyRef(params: {
  queryable?: Executor
  conversationId: string
  participantId?: string
  replyRef?: string
}) {
  if (!params.replyRef) {
    return null
  }

  const sequence = parseConversationMessageRef(params.replyRef)
  if (!Number.isFinite(sequence)) {
    throw createChatError(
      400,
      "invalid_reply_ref",
      'replyToRef must use the form "m_<sequence>"'
    )
  }

  const exactSql = `
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
    `
  const exact = params.queryable
    ? await runOn<Pick<ItemRow, "id" | "sequence">>(
        params.queryable,
        exactSql,
        [params.conversationId, sequence, params.participantId ?? null]
      )
    : await runOnDb<Pick<ItemRow, "id" | "sequence">>(exactSql, [
        params.conversationId,
        sequence,
        params.participantId ?? null,
      ])
  const row = exact.rows[0]
  if (row) {
    return {
      itemId: row.id,
      sequence: toNumber(row.sequence),
      ref: buildConversationMessageRef(toNumber(row.sequence)),
    }
  }

  const nearbySql = `
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
    `
  const nearby = params.queryable
    ? await runOn<Pick<ItemRow, "id" | "sequence">>(
        params.queryable,
        nearbySql,
        [params.conversationId, sequence, params.participantId ?? null]
      )
    : await runOnDb<Pick<ItemRow, "id" | "sequence">>(nearbySql, [
        params.conversationId,
        sequence,
        params.participantId ?? null,
      ])
  const suggestions = nearby.rows
    .map((candidate) =>
      buildConversationMessageRef(toNumber(candidate.sequence))
    )
    .filter((value, index, all) => all.indexOf(value) === index)
  const suggestionText =
    suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : ""

  throw createChatError(
    400,
    "invalid_reply_ref",
    `Unknown replyToRef "${params.replyRef}".${suggestionText}`
  )
}

async function prepareConversationItemWrite(
  queryable: Executor,
  params: {
    conversationId: string
    scope: ItemScope
    surface: ItemSurface
    parts?: ConversationItemPartInput[]
    restrictedAudienceParticipantIds?: string[]
    contextTargetParticipantIds?: string[]
    replyToItemId?: string
    authorParticipantId?: string
  }
): Promise<PreparedConversationItemWrite> {
  const activeParticipants =
    params.scope === CONVERSATION_ITEM_SCOPE.SHARED &&
    params.surface === CONVERSATION_ITEM_SURFACE.VISIBLE
      ? await listConversationParticipantRows(
          queryable,
          [params.conversationId],
          {
            useProfileSnapshot: true,
          }
        ).then((participants) =>
          participants.filter((participant) => participant.state === "active")
        )
      : []
  const validParticipantIds = new Set(
    activeParticipants.map((participant) => participant.id)
  )

  for (const participantId of params.restrictedAudienceParticipantIds ?? []) {
    if (!validParticipantIds.has(participantId)) {
      throw new Error(
        `Invalid restricted audience participant ${participantId}`
      )
    }
  }
  for (const participantId of params.contextTargetParticipantIds ?? []) {
    if (!validParticipantIds.has(participantId)) {
      throw new Error(`Invalid context target participant ${participantId}`)
    }
  }

  const normalizedParts = await canonicalizeConversationItemParts(queryable, {
    conversationId: params.conversationId,
    parts: params.parts,
    activeParticipants,
  })

  return {
    activeParticipants,
    parts: normalizedParts.parts,
    mentionedParticipants: normalizedParts.mentionedParticipants,
    replyToItem: await validateConversationReplyTarget(
      queryable,
      params.conversationId,
      params.replyToItemId,
      params.authorParticipantId
    ),
  }
}

async function listMentionedParticipantIdsForItem(
  queryable: Executor,
  itemId: string
) {
  const result = await runOn<{ mentioned_participant_id: string }>(
    queryable,
    `
      SELECT mentioned_participant_id
      FROM conversation_item_mentions
      WHERE item_id = $1
      ORDER BY ordinal ASC, mentioned_participant_id ASC
    `,
    [itemId]
  )
  return result.rows.map((row) => row.mentioned_participant_id)
}

function resolveActorWakeParticipants(params: {
  conversationKind: ConversationKind
  activeParticipants: ParticipantRow[]
  authorParticipantId?: string
  mentionedParticipantIds: string[]
  replyAuthorParticipantId?: string | null
}) {
  const actorParticipants = params.activeParticipants.filter(
    (participant) =>
      participant.id !== params.authorParticipantId &&
      participant.state === "active" &&
      typeof participant.actor_id === "string" &&
      participant.actor_id.length > 0
  )
  if (actorParticipants.length === 0) {
    return []
  }
  if (params.conversationKind !== "group") {
    return actorParticipants
  }

  const mentionedSet = new Set(params.mentionedParticipantIds)
  const explicitWakeTargets = new Map<string, ParticipantRow>()
  for (const participant of actorParticipants) {
    if (mentionedSet.has(participant.id)) {
      explicitWakeTargets.set(participant.id, participant)
    }
  }
  if (params.replyAuthorParticipantId) {
    const replyActor = actorParticipants.find(
      (participant) => participant.id === params.replyAuthorParticipantId
    )
    if (replyActor) {
      explicitWakeTargets.set(replyActor.id, replyActor)
    }
  }
  if (explicitWakeTargets.size > 0) {
    return Array.from(explicitWakeTargets.values())
  }
  if (params.mentionedParticipantIds.length > 0) {
    return []
  }
  return actorParticipants
}

export async function enqueueActorWakeupsForConversationMessage(params: {
  workspaceId?: string
  conversationId: string
  itemId: string
  // sourceParticipantType mixes a real participant author kind with the
  // "system" wakeup source (automation / tool-call completion), so it is typed
  // as the wakeup-source enum (which retains 'system') rather than
  // ParticipantKind. The DB participant kind never equals 'system'.
  sourceParticipantType?: SessionWakeupSourceParticipantType
  sourceParticipantId?: string
  sourceName?: string
  summary?: string
  queryable?: Executor
}) {
  if (!params.workspaceId) {
    return [] as PendingActorWakeup[]
  }
  const queryable = params.queryable ?? rootQueryable()
  const itemRows = await listItemRowsByIds(queryable, [params.itemId])
  const itemRow = itemRows[0]
  if (!itemRow) {
    return [] as PendingActorWakeup[]
  }
  if (
    itemRow.item_type !== "message" ||
    itemRow.scope !== "shared" ||
    itemRow.surface !== "visible"
  ) {
    return [] as PendingActorWakeup[]
  }

  const restrictedAudienceResult = await runOn<ParticipantLinkRow>(
    queryable,
    `
      SELECT item_id, target_participant_id
      FROM conversation_item_targets
      WHERE item_id = $1
    `,
    [params.itemId]
  )
  if (restrictedAudienceResult.rows.length > 0) {
    return [] as PendingActorWakeup[]
  }

  const conversationRow = await runOn<{ kind: ConversationKind }>(
    queryable,
    `
      SELECT kind
      FROM conversations
      WHERE id = $1
      LIMIT 1
    `,
    [params.conversationId]
  )
  const conversationKind = conversationRow.rows[0]?.kind
  if (!conversationKind) {
    return [] as PendingActorWakeup[]
  }

  const activeParticipants = await listConversationParticipantRows(
    queryable,
    [params.conversationId],
    { useProfileSnapshot: true }
  ).then((participants) =>
    participants.filter((participant) => participant.state === "active")
  )
  const authorParticipant = itemRow.author_participant_id
    ? activeParticipants.find(
        (participant) => participant.id === itemRow.author_participant_id
      )
    : undefined
  const sourceParticipantType =
    params.sourceParticipantType ?? authorParticipant?.participant_type
  if (!sourceParticipantType || sourceParticipantType === "system") {
    return [] as PendingActorWakeup[]
  }

  const mentionedParticipantIds = await listMentionedParticipantIdsForItem(
    queryable,
    params.itemId
  )
  const replyAuthorParticipantId = itemRow.reply_to_item_id
    ? ((await listItemRowsByIds(queryable, [itemRow.reply_to_item_id]))[0]
        ?.author_participant_id ?? null)
    : null
  const wakeParticipants = resolveActorWakeParticipants({
    conversationKind,
    activeParticipants,
    authorParticipantId: itemRow.author_participant_id ?? undefined,
    mentionedParticipantIds,
    replyAuthorParticipantId,
  })
  if (wakeParticipants.length === 0) {
    return [] as PendingActorWakeup[]
  }

  const sourceType =
    sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
      ? "actor_message"
      : "user_message"
  const sourceParticipantId =
    params.sourceParticipantId ??
    (sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
      ? (authorParticipant?.workspace_member_id ?? undefined)
      : sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
        ? (authorParticipant?.actor_id ?? undefined)
        : (itemRow.author_participant_id ?? undefined))
  const sourceName =
    params.sourceName ??
    (authorParticipant ? participantDisplayName(authorParticipant) : undefined)
  const itemSummary =
    params.summary ??
    (await hydrateConversationItems(queryable, [itemRow]))
      .map((item) => item.content.trim())
      .find(Boolean) ??
    "New message"

  const { ensureConversationActorSessionContext } =
    await import("../session/service.js")
  const { enqueueSessionWakeup } = await import("../session/runtime.js")
  const pendingWakeups: PendingActorWakeup[] = []

  for (const participant of wakeParticipants) {
    if (!participant.actor_id) {
      continue
    }
    const ensuredContext = await ensureConversationActorSessionContext(
      {
        workspaceId: params.workspaceId,
        actorId: participant.actor_id,
        conversationId: params.conversationId,
        trigger: sourceType,
      },
      queryable
    )
    await enqueueSessionWakeup({
      sessionId: ensuredContext.sessionId,
      actorId: participant.actor_id,
      workspaceId: params.workspaceId,
      sourceType,
      sourceItemId: params.itemId,
      sourceParticipantType,
      sourceParticipantId,
      sourceName,
      summary:
        itemSummary.replace(/\s+/g, " ").trim().slice(0, 96) || "New message",
      metadata: {
        source: "chat.message_wakeup",
        conversationId: params.conversationId,
      },
      trigger: sourceType,
    })
    pendingWakeups.push({
      actorId: participant.actor_id,
      sessionId: ensuredContext.sessionId,
      sourceType,
    })
  }

  return pendingWakeups
}

async function loadHumanParticipantsForConversation(
  queryable: Executor,
  conversationId: string
) {
  const participants = await listConversationParticipantRows(queryable, [
    conversationId,
  ])
  return participants.filter(
    (participant) =>
      participant.state === "active" &&
      typeof participant.workspace_member_id === "string" &&
      participant.workspace_member_id.length > 0
  )
}

async function syncConversationUpsertForWorkspaceMembers(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string
) {
  for (const workspaceMemberId of [...new Set(workspaceMemberIds)]) {
    const conversation = await loadConversationView(
      queryable,
      workspaceId,
      workspaceMemberId,
      conversationId
    )
    if (!conversation) {
      continue
    }
    await appendWorkspaceMemberSyncEvent(queryable, {
      workspaceId,
      workspaceMemberId,
      conversationId,
      eventType: "conversation.upsert",
      payload: {
        conversation,
      },
    })
  }
}

/**
 * Resolve the access_subjects.id for a participant of the given kind, minting
 * the subject if needed. Shared by `insertParticipant` (write) and
 * `ensureConversationParticipant` (dedup lookup) so both agree on the subject
 * identity — dedup is keyed on (conversation_id, subject_id), not display_name.
 */
async function resolveParticipantSubjectId(
  queryable: Executor,
  params: {
    participantType: ParticipantKind
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    transportAddressId?: string
  }
): Promise<string> {
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
    params.workspaceMemberId
  ) {
    return upsertAccessSubjectOn(queryable, {
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      memberId: params.workspaceMemberId,
    })
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
    params.actorId
  ) {
    return upsertAccessSubjectOn(queryable, {
      kind: SUBJECT_KIND.ACTOR,
      actorId: params.actorId,
    })
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    params.remoteAgentId
  ) {
    return upsertAccessSubjectOn(queryable, {
      kind: SUBJECT_KIND.REMOTE_AGENT,
      remoteAgentId: params.remoteAgentId,
    })
  }
  // external participant. Require a transport identity (no throwaway).
  if (!params.transportAddressId) {
    throw new Error(
      "resolveParticipantSubjectId: external participant requires transportAddressId"
    )
  }
  // Defence-in-depth: every funnel that mints an external subject validates the
  // address here, so a future caller of ensureConversationParticipant can't
  // attach a bot/system or member-linked address as an external participant —
  // even if it skips the higher-level validateTransportAddresses gate.
  const addr = await runOn<{
    workspace_id: string
    address_type: string
    workspace_member_id: string | null
  }>(
    queryable,
    `SELECT workspace_id, address_type, workspace_member_id
       FROM transport_addresses WHERE id = $1`,
    [params.transportAddressId]
  )
  if (!addr.rows[0]) {
    throw new Error(
      `resolveParticipantSubjectId: transport_addresses(${params.transportAddressId}) not found`
    )
  }
  if (addr.rows[0].address_type !== "user") {
    throw new Error(
      `resolveParticipantSubjectId: address ${params.transportAddressId} is not a user address`
    )
  }
  if (addr.rows[0].workspace_member_id) {
    throw new Error(
      `resolveParticipantSubjectId: address ${params.transportAddressId} is linked to a workspace member; add it as a member, not an external participant`
    )
  }
  return upsertAccessSubjectOn(queryable, {
    kind: SUBJECT_KIND.EXTERNAL,
    workspaceId: addr.rows[0].workspace_id,
    transportAddressId: params.transportAddressId,
  })
}

async function insertParticipant(
  queryable: Executor,
  params: {
    conversationId: string
    participantType: ParticipantKind
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    actorJoinVersionId?: string
    displayName?: string
    roleKey: string
    metadata?: Record<string, unknown>
    // The transport identity for an external participant: mints the first-class
    // subject AND is bound to the participant via conversation_participant_addresses.
    transportAddressId?: string
    // Optional pre-resolved subject id (from resolveParticipantSubjectId) so
    // the dedup lookup and the insert agree on the same subject without
    // resolving twice.
    subjectId?: string
  }
) {
  const participantId = crypto.randomUUID()
  // Every participant gets a real subject_id. Workspace_member / actor /
  // remote_agent map to their canonical access_subjects rows; external maps to
  // a first-class, workspace-rooted subject keyed by its transport_address
  // (deduped across conversations). There is no throwaway/anonymous escape
  // hatch — an external participant must carry a transport identity.
  const participantSubjectId =
    params.subjectId ?? (await resolveParticipantSubjectId(queryable, params))
  await queryable
    .insertInto("conversation_participants")
    .values({
      id: participantId,
      conversation_id: params.conversationId,
      subject_id: participantSubjectId,
      actor_join_version_id: params.actorJoinVersionId ?? null,
      display_name: params.displayName ?? null,
      role_key: params.roleKey,
      state: "active",
      metadata: jsonbValue(params.metadata ?? {}),
      joined_at: sql`NOW()`,
    })
    .execute()

  await queryable
    .insertInto("conversation_participant_states")
    .values({
      conversation_id: params.conversationId,
      participant_id: participantId,
      read_watermark_sequence: 0,
      created_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["conversation_id", "participant_id"]).doNothing()
    )
    .execute()

  if (params.transportAddressId) {
    await queryable
      .insertInto("conversation_participant_addresses")
      .values({
        conversation_participant_id: participantId,
        transport_address_id: params.transportAddressId,
        is_primary: true,
        metadata: jsonbValue({}),
        created_at: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc
          .columns(["conversation_participant_id", "transport_address_id"])
          .doNothing()
      )
      .execute()
  }

  return {
    id: participantId,
  }
}

async function loadWorkspaceMembersByIds(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[]
) {
  if (workspaceMemberIds.length === 0) {
    return [] as Array<{ id: string; user_name: string }>
  }
  const result = await runOn<{ id: string; user_name: string }>(
    queryable,
    `
      SELECT wm.id, u.name AS user_name
      FROM workspace_members wm
      INNER JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1
        AND wm.id = ANY($2::uuid[])
    `,
    [workspaceId, workspaceMemberIds]
  )
  return result.rows
}

async function loadActorsByIds(
  queryable: Executor,
  workspaceId: string,
  actorIds: string[]
) {
  if (actorIds.length === 0) {
    return [] as Array<{ id: string; display_name: string }>
  }
  const result = await runOn<{ id: string; display_name: string }>(
    queryable,
    `
      SELECT actor.id, app.display_name
      FROM actors actor
      INNER JOIN workspace_apps_live app
        ON app.id = actor.id
      WHERE app.workspace_id = $1
        AND app.deleted_at IS NULL
        AND app.status = 'active'
        AND actor.id = ANY($2::uuid[])
    `,
    [workspaceId, actorIds]
  )
  return result.rows
}

async function loadRemoteAgentsByIds(
  queryable: Executor,
  workspaceId: string,
  remoteAgentIds: string[]
) {
  if (remoteAgentIds.length === 0) {
    return [] as Array<{ id: string; display_name: string }>
  }
  const result = await runOn<{ id: string; display_name: string }>(
    queryable,
    `
      SELECT agent.id, app.display_name
      FROM remote_agents agent
      INNER JOIN workspace_apps_live app
        ON app.id = agent.id
      WHERE app.workspace_id = $1
        AND app.deleted_at IS NULL
        AND app.status = 'active'
        AND agent.id = ANY($2::uuid[])
    `,
    [workspaceId, remoteAgentIds]
  )
  return result.rows
}

export async function getConversation(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  const result = await runOn<Record<string, unknown>>(
    queryable,
    `
      SELECT *
      FROM conversations
      WHERE id = $1
      LIMIT 1
    `,
    [conversationId]
  )
  return result.rows[0] ?? null
}

export async function createConversation(params: {
  kind: ConversationKind
  workspaceId: string
  title?: string
  createdByWorkspaceMemberId?: string
  metadata?: Record<string, unknown>
  queryable?: Executor
}) {
  const queryable = params.queryable ?? rootQueryable()
  if (!params.workspaceId) {
    // Every conversation is workspace-scoped (conversations.workspace_id is
    // NOT NULL). Assert here so a missing id fails loudly instead of writing a
    // null and tripping the DB constraint deep in a transaction.
    throw new Error("createConversation: workspaceId is required")
  }
  const id = crypto.randomUUID()
  const result = await runOn<Record<string, unknown>>(
    queryable,
    `
      INSERT INTO conversations (
        id,
        kind,
        workspace_id,
        title,
        created_by_workspace_member_id,
        metadata,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())
      RETURNING *
    `,
    [
      id,
      params.kind,
      params.workspaceId,
      params.title?.trim() || null,
      params.createdByWorkspaceMemberId ?? null,
      JSON.stringify(params.metadata ?? {}),
    ]
  )
  const created = result.rows[0]
  if (!created) {
    throw new Error("Failed to create conversation")
  }
  return created
}

export async function createConversationForWorkspaceMember(params: {
  workspaceId: string
  creatorWorkspaceMemberId?: string
  kind: ConversationKind
  title?: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  metadata?: Record<string, unknown>
  queryable?: Executor
}) {
  const executeCreate = async (queryable: Executor) => {
    const workspaceMemberIds = [
      ...new Set(
        [
          ...(params.creatorWorkspaceMemberId
            ? [params.creatorWorkspaceMemberId]
            : []),
          ...(params.workspaceMemberIds ?? []),
        ].filter(Boolean)
      ),
    ]
    const actorIds = [...new Set(params.actorIds ?? [])]
    const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]

    // Validate EVERY participant before creating the conversation, so a rejected
    // request never leaves an orphan conversation behind (the caller may pass a
    // non-transactional queryable). External participants are NOT created here:
    // they are minted only by the IM ingest path
    // (syncTransportAddressConversationParticipant).
    const memberRows =
      workspaceMemberIds.length > 0
        ? await loadWorkspaceMembersByIds(
            queryable,
            params.workspaceId,
            workspaceMemberIds
          )
        : []
    if (memberRows.length !== workspaceMemberIds.length) {
      throw createChatError(
        400,
        "invalid_workspace_member",
        "One or more workspace members are invalid"
      )
    }
    const actorRows =
      actorIds.length > 0
        ? await loadActorsByIds(queryable, params.workspaceId, actorIds)
        : []
    if (actorRows.length !== actorIds.length) {
      throw createChatError(
        400,
        "invalid_actor",
        "One or more actors are invalid"
      )
    }
    const remoteAgentRows =
      remoteAgentIds.length > 0
        ? await loadRemoteAgentsByIds(
            queryable,
            params.workspaceId,
            remoteAgentIds
          )
        : []
    if (remoteAgentRows.length !== remoteAgentIds.length) {
      throw createChatError(
        400,
        "invalid_remote_agent",
        "One or more remote agents are invalid"
      )
    }

    const conversation = await createConversation({
      kind: params.kind,
      workspaceId: params.workspaceId,
      title: params.title,
      createdByWorkspaceMemberId: params.creatorWorkspaceMemberId,
      metadata: params.metadata,
      queryable,
    })

    for (const member of memberRows) {
      await ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: "workspace_member",
        workspaceMemberId: member.id,
        displayName: member.user_name,
        roleKey:
          member.id === params.creatorWorkspaceMemberId ? "owner" : "member",
        queryable,
      })
      await upsertConversationView(queryable, {
        workspaceMemberId: member.id,
        conversationId: conversation.id as string,
        unreadCount: 0,
      })
    }

    for (const actor of actorRows) {
      await ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: "actor",
        actorId: actor.id,
        displayName: actor.display_name,
        queryable,
      })
    }

    for (const remoteAgent of remoteAgentRows) {
      await ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: "remote_agent",
        remoteAgentId: remoteAgent.id,
        displayName: remoteAgent.display_name,
        queryable,
      })
    }

    if (workspaceMemberIds.length > 0) {
      await syncConversationUpsertForWorkspaceMembers(
        queryable,
        params.workspaceId,
        workspaceMemberIds,
        conversation.id as string
      )
    }

    return conversation
  }

  if (params.queryable) {
    return executeCreate(params.queryable)
  }
  return withDbTransaction((client) => executeCreate(client))
}

export async function listConversationParticipants(
  conversationId: string,
  options?: { useProfileSnapshot?: boolean; queryable?: Executor }
) {
  return listConversationParticipantRows(
    options?.queryable ?? rootQueryable(),
    [conversationId],
    { useProfileSnapshot: options?.useProfileSnapshot }
  )
}

export async function getConversationParticipant(params: {
  conversationId: string
  participantId?: string
  actorId?: string
  remoteAgentId?: string
  workspaceMemberId?: string
  transportAddressId?: string
  queryable?: Executor
}) {
  if (params.participantId) {
    const result = await runOn<ParticipantRow>(
      params.queryable ?? rootQueryable(),
      `
        SELECT *
        FROM conversation_participants
        WHERE conversation_id = $1
          AND id = $2
        LIMIT 1
      `,
      [params.conversationId, params.participantId]
    )
    const row = result.rows[0]
    if (!row) {
      return null
    }
  }

  const participants = await listConversationParticipants(
    params.conversationId,
    {
      queryable: params.queryable,
    }
  )
  return (
    participants.find((participant) =>
      params.participantId
        ? participant.id === params.participantId
        : params.actorId
          ? participant.actor_id === params.actorId
          : params.remoteAgentId
            ? participant.remote_agent_id === params.remoteAgentId
            : params.workspaceMemberId
              ? participant.workspace_member_id === params.workspaceMemberId
              : params.transportAddressId
                ? participant.transport_address_id === params.transportAddressId
                : false
    ) ?? null
  )
}

export async function ensureConversationParticipant(params: {
  conversationId: string
  participantType: ParticipantKind
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  displayName?: string
  actorJoinVersionId?: string
  roleKey?: string
  metadata?: Record<string, unknown>
  transportAddressId?: string
  queryable?: Executor
}) {
  const queryable = params.queryable ?? rootQueryable()
  const conversation = await getConversation(params.conversationId, queryable)
  if (!conversation) {
    throw new Error("Conversation not found")
  }

  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
    !params.workspaceMemberId
  ) {
    throw new Error("workspaceMemberId is required for workspace participants")
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
    !params.actorId
  ) {
    throw new Error("actorId is required for actor participants")
  }
  if (
    params.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    !params.remoteAgentId
  ) {
    throw new Error("remoteAgentId is required for remote agent participants")
  }

  // F3: resolve the target subject_id up front and dedup by
  // (conversation_id, subject_id) — the canonical identity — instead of by
  // display_name (which let a renamed external participant insert a duplicate
  // and let two different externals with the same name collide).
  const targetSubjectId = await resolveParticipantSubjectId(queryable, {
    participantType: params.participantType,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    transportAddressId: params.transportAddressId,
  })

  const existing = await runBuilder(
    queryable,
    queryable
      .selectFrom("conversation_participants")
      .select(["id", "state"])
      .where("conversation_id", "=", params.conversationId)
      .where("subject_id", "=", targetSubjectId)
      .limit(1)
  )

  const existingId = existing.rows[0]?.id
  if (existingId) {
    // P1b: subject_id is fixed at insert time. The existing-participant path
    // only refreshes presentation/state fields; the workspace_member_id /
    // actor_id / remote_agent_id columns no longer exist on this table.
    await queryable
      .updateTable("conversation_participants")
      .set({
        actor_join_version_id: sql`COALESCE(${
          params.actorJoinVersionId ?? null
        }, actor_join_version_id)`,
        display_name: sql`COALESCE(${
          params.displayName ?? null
        }, display_name)`,
        role_key: sql`COALESCE(${params.roleKey ?? "member"}, role_key)`,
        state: "active",
        left_at: null,
        metadata: sql`COALESCE(conversation_participants.metadata, '{}'::jsonb) || ${jsonbValue(
          params.metadata ?? {}
        )}`,
      })
      .where("id", "=", existingId)
      .execute()

    if (params.transportAddressId) {
      await queryable
        .insertInto("conversation_participant_addresses")
        .values({
          conversation_participant_id: existingId,
          transport_address_id: params.transportAddressId,
          is_primary: true,
          metadata: jsonbValue({}),
          created_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc
            .columns(["conversation_participant_id", "transport_address_id"])
            .doUpdateSet({
              is_primary: sql`EXCLUDED.is_primary`,
            })
        )
        .execute()
    }

    return getConversationParticipant({
      conversationId: params.conversationId,
      participantId: existingId,
      queryable,
    })
  }

  const inserted = await insertParticipant(queryable, {
    conversationId: params.conversationId,
    participantType: params.participantType,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    actorJoinVersionId: params.actorJoinVersionId,
    displayName: params.displayName,
    roleKey: params.roleKey ?? "member",
    metadata: params.metadata,
    transportAddressId: params.transportAddressId,
    subjectId: targetSubjectId,
  })

  return getConversationParticipant({
    conversationId: params.conversationId,
    participantId: inserted.id,
    queryable,
  })
}

/**
 * Map each requested workspace_member_id to its CURRENT participant state in the
 * conversation ('active' | 'left' | 'removed'), or undefined if never a
 * participant. Used by addConversationParticipants to distinguish a true re-add
 * (prior 'removed'/'left' → emit membership.updated{active} to clear the client
 * tombstone) from a no-op (already 'active') or a first-time add.
 */
async function loadParticipantStatesByMember(
  queryable: Executor,
  conversationId: string,
  workspaceMemberIds: string[]
): Promise<Map<string, string>> {
  if (workspaceMemberIds.length === 0) return new Map()
  const result = await runOn<{ workspace_member_id: string; state: string }>(
    queryable,
    `
      SELECT cps.workspace_member_id, cp.state
      FROM conversation_participants cp
      INNER JOIN access_subjects cps ON cps.id = cp.subject_id
      WHERE cp.conversation_id = $1
        AND cps.workspace_member_id = ANY($2::uuid[])
    `,
    [conversationId, workspaceMemberIds]
  )
  const map = new Map<string, string>()
  for (const row of result.rows) {
    map.set(row.workspace_member_id, row.state)
  }
  return map
}

export async function addConversationParticipants(params: {
  workspaceId: string
  conversationId: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  queryable?: Executor
}) {
  const executeAdd = async (queryable: Executor) => {
    const workspaceMemberIds = [...new Set(params.workspaceMemberIds ?? [])]
    const actorIds = [...new Set(params.actorIds ?? [])]
    const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]
    // External participants are not addable through this public path; they are
    // minted only by the IM ingest path
    // (syncTransportAddressConversationParticipant).

    if (workspaceMemberIds.length > 0) {
      const memberRows = await loadWorkspaceMembersByIds(
        queryable,
        params.workspaceId,
        workspaceMemberIds
      )
      if (memberRows.length !== workspaceMemberIds.length) {
        throw createChatError(
          400,
          "invalid_workspace_member",
          "One or more workspace members are invalid"
        )
      }

      // Capture each requested member's PRIOR participation state (before the
      // ensure reactivates them) so we can distinguish a true re-add (was
      // removed/left) from a no-op (already active) or a brand-new add. A
      // re-add must emit conversation.membership.updated{active} so the client
      // clears its tombstone — a plain conversation.upsert would be rejected by
      // the tombstone guard until then.
      const priorStateByMember = await loadParticipantStatesByMember(
        queryable,
        params.conversationId,
        workspaceMemberIds
      )
      // Pre-existing active members (before this add) — they need a roster
      // refresh too, not just the newly-added members.
      const preExistingRecipients = await listConversationRealtimeRecipients(
        params.conversationId,
        queryable
      )

      for (const member of memberRows) {
        await ensureConversationParticipant({
          conversationId: params.conversationId,
          participantType: "workspace_member",
          workspaceMemberId: member.id,
          displayName: member.user_name,
          queryable,
        })
        await upsertConversationView(queryable, {
          workspaceMemberId: member.id,
          conversationId: params.conversationId,
          unreadCount: 0,
        })
      }

      // Refresh the roster for everyone now active (pre-existing ∪ added).
      const upsertTargets = [
        ...new Set([
          ...preExistingRecipients.map((r) => r.workspaceMemberId),
          ...workspaceMemberIds,
        ]),
      ]
      await syncConversationUpsertForWorkspaceMembers(
        queryable,
        params.workspaceId,
        upsertTargets,
        params.conversationId
      )

      // Re-added members (prior state removed/left): clear their tombstone.
      for (const memberId of workspaceMemberIds) {
        const prior = priorStateByMember.get(memberId)
        if (prior === "removed" || prior === "left") {
          const activeParticipants = await listConversationParticipants(
            params.conversationId,
            { queryable }
          )
          await appendWorkspaceMemberSyncEvent(queryable, {
            workspaceId: params.workspaceId,
            workspaceMemberId: memberId,
            conversationId: params.conversationId,
            eventType: "conversation.membership.updated",
            payload: {
              conversationId: params.conversationId,
              selfState: "active",
              reason: "added",
              participants: activeParticipants
                .filter((p) => p.state === "active")
                .map(participantRowToChatParticipantSummary),
            },
          })
        }
      }
    }

    if (actorIds.length > 0) {
      const actorRows = await loadActorsByIds(
        queryable,
        params.workspaceId,
        actorIds
      )
      if (actorRows.length !== actorIds.length) {
        throw createChatError(
          400,
          "invalid_actor",
          "One or more actors are invalid"
        )
      }
      for (const actor of actorRows) {
        await ensureConversationParticipant({
          conversationId: params.conversationId,
          participantType: "actor",
          actorId: actor.id,
          displayName: actor.display_name,
          queryable,
        })
      }
    }

    if (remoteAgentIds.length > 0) {
      const remoteAgentRows = await loadRemoteAgentsByIds(
        queryable,
        params.workspaceId,
        remoteAgentIds
      )
      if (remoteAgentRows.length !== remoteAgentIds.length) {
        throw createChatError(
          400,
          "invalid_remote_agent",
          "One or more remote agents are invalid"
        )
      }
      for (const remoteAgent of remoteAgentRows) {
        await ensureConversationParticipant({
          conversationId: params.conversationId,
          participantType: "remote_agent",
          remoteAgentId: remoteAgent.id,
          displayName: remoteAgent.display_name,
          queryable,
        })
      }
    }

    // Note: the conversation.upsert roster refresh for member adds is emitted
    // inside the workspaceMemberIds block above (union of pre-existing + added),
    // so it is intentionally NOT repeated here.

    return listConversationParticipants(params.conversationId, { queryable })
  }

  if (params.queryable) {
    return executeAdd(params.queryable)
  }
  return withDbTransaction((client) => executeAdd(client))
}

export async function createConversationItem(params: {
  workspaceId?: string
  conversationId: string
  sessionId?: string
  turnId?: string
  clientMessageId?: string
  scope: ItemScope
  surface: ItemSurface
  itemType: ItemType
  subtype: string
  role: ItemRole
  authorParticipantId?: string
  bundleId?: string
  replyToItemId?: string
  causedByItemId?: string
  eventPayload?: unknown
  eventTimelinePolicy?: ConversationEventTimelinePolicy
  eventContextPolicy?: ConversationEventContextPolicy
  metadata?: Record<string, unknown>
  parts?: ConversationItemPartInput[]
  restrictedAudienceParticipantIds?: string[]
  contextTargetParticipantIds?: string[]
  queryable?: Executor
}) {
  const executeInsert = async (queryable: Executor) => {
    const prepared = await prepareConversationItemWrite(queryable, {
      conversationId: params.conversationId,
      scope: params.scope,
      surface: params.surface,
      parts: params.parts,
      restrictedAudienceParticipantIds: params.restrictedAudienceParticipantIds,
      contextTargetParticipantIds: params.contextTargetParticipantIds,
      replyToItemId: params.replyToItemId,
      authorParticipantId: params.authorParticipantId,
    })

    const itemId = crypto.randomUUID()
    let insertedItem: ItemRow | null = null

    const inserted = await runOn<ItemRow>(
      queryable,
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
          reply_to_item_id,
          caused_by_item_id,
          event_payload,
          event_timeline_policy,
          event_context_policy,
          metadata,
          sequence,
          created_at
      `,
      [
        itemId,
        params.conversationId,
        params.sessionId ?? null,
        params.turnId ?? null,
        params.clientMessageId ?? null,
        params.scope,
        params.surface,
        params.itemType,
        params.subtype,
        params.role,
        params.authorParticipantId ?? null,
        params.bundleId ?? null,
        prepared.replyToItem?.id ?? null,
        params.causedByItemId ?? null,
        JSON.stringify(params.eventPayload ?? {}),
        params.eventTimelinePolicy ?? null,
        params.eventContextPolicy ?? null,
        JSON.stringify(params.metadata ?? {}),
      ]
    )
    insertedItem = inserted.rows[0] ?? null

    if (!insertedItem && params.clientMessageId && params.authorParticipantId) {
      const existing = await runOn<ItemRow>(
        queryable,
        `
          SELECT
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
            reply_to_item_id,
            caused_by_item_id,
            event_payload,
            event_timeline_policy,
            event_context_policy,
            metadata,
            sequence,
            created_at
          FROM conversation_items
          WHERE conversation_id = $1
            AND author_participant_id = $2
            AND client_message_id = $3
          LIMIT 1
        `,
        [
          params.conversationId,
          params.authorParticipantId,
          params.clientMessageId,
        ]
      )
      insertedItem = existing.rows[0] ?? null
    }

    if (!insertedItem) {
      throw new Error("Failed to create conversation item")
    }

    const isDuplicate =
      insertedItem.id !== itemId &&
      !!params.clientMessageId &&
      !!params.authorParticipantId
    if (isDuplicate) {
      // S6 dedup observability: a duplicate clientMessageId reaching the
      // server means main thread + SW both flushed the same outbox
      // entry. Counter is exposed via getChatDedupCountersSnapshot().
      recordDuplicateClientMessageIdSend()
      const duplicateItems = await buildChatConversationItems(queryable, [
        insertedItem,
      ])
      return duplicateItems[0]!
    }

    for (const [ordinal, part] of prepared.parts.entries()) {
      await queryable
        .insertInto("conversation_item_parts")
        .values({
          id: crypto.randomUUID(),
          item_id: insertedItem.id,
          ordinal,
          part_type: part.type,
          text_value: part.type === "text" ? (part.text ?? "") : null,
          ref_path: part.type === "file_ref" ? (part.refPath ?? null) : null,
          ref_sha256:
            part.type === "file_ref" ? (part.refSha256 ?? null) : null,
          json_value: part.type === "json" ? jsonbValue(part.json ?? {}) : null,
          mime_type: part.mimeType ?? null,
          name: part.name ?? null,
          metadata: jsonbValue(part.metadata ?? {}),
        })
        .execute()
    }

    if (prepared.mentionedParticipants.length > 0) {
      for (const mention of prepared.mentionedParticipants) {
        await queryable
          .insertInto("conversation_item_mentions")
          .values({
            item_id: insertedItem.id,
            ordinal: mention.ordinal,
            mentioned_participant_id: mention.participantId,
          })
          .execute()
      }
    }

    for (const participantId of params.restrictedAudienceParticipantIds ?? []) {
      await queryable
        .insertInto("conversation_item_targets")
        .values({
          item_id: insertedItem.id,
          target_participant_id: participantId,
          target_kind: "to",
        })
        .execute()
    }

    for (const participantId of params.contextTargetParticipantIds ?? []) {
      await queryable
        .insertInto("conversation_item_context_targets")
        .values({
          item_id: insertedItem.id,
          target_participant_id: participantId,
        })
        .execute()
    }

    await queryable
      .updateTable("conversations")
      // Conversation items are appended in child tables; touching the parent
      // conversation preserves "last activity" semantics for list ordering.
      .set({ updated_at: sql`NOW()` })
      .where("id", "=", params.conversationId)
      .execute()

    const hydrated = await buildChatConversationItems(queryable, [insertedItem])
    const item = hydrated[0]
    if (!item) {
      throw new Error("Failed to hydrate conversation item")
    }

    if (
      params.scope === CONVERSATION_ITEM_SCOPE.SHARED &&
      params.surface === CONVERSATION_ITEM_SURFACE.VISIBLE
    ) {
      await syncVisibleSharedItem({
        queryable,
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        item,
        activeParticipants: prepared.activeParticipants,
        authorParticipantId: params.authorParticipantId,
        restrictedAudienceParticipantIds:
          params.restrictedAudienceParticipantIds,
      })

      const { createRemoteAgentDeliveriesForItem } =
        await import("../remote-agents/service.js")
      await createRemoteAgentDeliveriesForItem({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        itemId: item.id,
        authorParticipantId: params.authorParticipantId,
        queryable,
      })
    }

    return item
  }

  if (params.queryable) {
    return executeInsert(params.queryable)
  }
  return withDbTransaction((client) => executeInsert(client))
}

export async function sendConversationMessageFromParticipant(params: {
  workspaceId?: string
  conversationId: string
  senderParticipantId: string
  sessionId?: string
  clientMessageId?: string
  role?: "user" | "assistant" | "system"
  contentBlocks: CanonicalContentBlock[]
  replyToItemId?: string
  metadata?: Record<string, unknown>
  queryable?: Executor
}) {
  if (
    !Array.isArray(params.contentBlocks) ||
    params.contentBlocks.length === 0
  ) {
    throw new Error("contentBlocks is required")
  }
  const normalized = await buildNormalizedMessageContent({
    content: "",
    contentBlocks: params.contentBlocks,
    metadata: params.metadata ?? {},
  })

  const item = await createConversationItem({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    clientMessageId: params.clientMessageId,
    scope: "shared",
    surface: "visible",
    itemType: "message",
    subtype: "chat.message",
    role: params.role ?? "user",
    authorParticipantId: params.senderParticipantId,
    replyToItemId: params.replyToItemId,
    metadata: normalized.normalizedMetadata,
    parts: normalized.parts,
    queryable: params.queryable,
  })
  if (params.queryable || !params.workspaceId) {
    return item
  }
  await enqueueActorWakeupsForConversationMessage({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    itemId: item.id,
  })
  const { notifyRemoteAgentDeliveriesForConversation } =
    await import("../remote-agents/service.js")
  await notifyRemoteAgentDeliveriesForConversation(params.conversationId)
  return item
}

export async function createConversationEvent<
  T extends ConversationFeedEventType,
>(params: {
  workspaceId?: string
  conversationId: string
  sessionId?: string
  turnId?: string
  eventType: T
  authorParticipantId?: string
  metadata?: Record<string, unknown>
  eventPayload: ConversationFeedEventPayloadMap[T]
  timelinePolicy?: ConversationEventTimelinePolicy
  contextPolicy?: ConversationEventContextPolicy
  restrictedAudienceParticipantIds?: string[]
  contextTargetParticipantIds?: string[]
  queryable?: Executor
}) {
  const executeCreate = async (queryable: Executor) => {
    const spec = getConversationEventSpec(params.eventType)
    const timelinePolicy = params.timelinePolicy ?? spec.timelinePolicy
    const contextPolicy = params.contextPolicy ?? spec.contextPolicy
    const eventPayload = params.eventPayload
    const participants = await listConversationParticipantRows(queryable, [
      params.conversationId,
    ])
    const activeParticipants = participants.filter(
      (participant) => participant.state === "active"
    )

    const timelineTargetParticipantIds =
      timelinePolicy === "targeted_members"
        ? [...new Set(params.restrictedAudienceParticipantIds ?? [])]
        : timelinePolicy === "users_only"
          ? activeParticipants
              .filter((participant) => participant.workspace_member_id)
              .map((participant) => participant.id)
          : timelinePolicy === "actors_only"
            ? activeParticipants
                .filter((participant) => participant.actor_id)
                .map((participant) => participant.id)
            : []

    const contextTargetParticipantIds =
      contextPolicy === "targeted_members"
        ? [...new Set(params.contextTargetParticipantIds ?? [])]
        : contextPolicy === "shared"
          ? activeParticipants
              .filter((participant) => participant.actor_id)
              .map((participant) => participant.id)
          : contextPolicy === "actor_private"
            ? [...new Set(params.contextTargetParticipantIds ?? [])]
            : []

    const normalizedTimeline = await buildNormalizedMessageContent({
      content: "",
      contentBlocks: renderConversationEventTimelineBlocks(
        params.eventType,
        eventPayload
      ),
      metadata: params.metadata ?? {},
    })

    const item = await createConversationItem({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      scope: "shared",
      surface: timelinePolicy === "none" ? "internal" : "visible",
      itemType: "event",
      subtype: params.eventType,
      role: "system",
      authorParticipantId: params.authorParticipantId,
      eventPayload,
      eventTimelinePolicy: timelinePolicy,
      eventContextPolicy: contextPolicy,
      metadata: params.metadata ?? {},
      parts: normalizedTimeline.parts,
      restrictedAudienceParticipantIds: timelineTargetParticipantIds,
      contextTargetParticipantIds,
      queryable,
    })

    if (item.itemType !== "event") {
      throw new Error(
        `Expected event item for conversation event ${params.eventType}`
      )
    }

    return {
      item: item as ChatConversationEventItem<T>,
      timelinePolicy,
      contextPolicy,
      timelineTargetParticipantIds,
      contextTargetParticipantIds,
      timelineContent: normalizedTimeline.normalizedContent,
      timelineContentBlocks: normalizedTimeline.contentBlocks,
      metadata: normalizedTimeline.normalizedMetadata,
      eventPayload,
    }
  }

  if (params.queryable) {
    return executeCreate(params.queryable)
  }
  return withDbTransaction((client) => executeCreate(client))
}

export async function updateConversationItemEventPayload<
  T extends ConversationFeedEventType,
>(
  itemId: string,
  payload: ConversationFeedEventPayloadMap[T],
  queryable: Executor = rootQueryable()
) {
  await queryable
    .updateTable("conversation_items")
    .set({ event_payload: jsonbValue(payload) })
    .where("id", "=", itemId)
    .execute()
}

async function buildConversationItemDetails(
  queryable: Executor,
  itemRows: ItemRow[]
): Promise<ConversationItemDetail[]> {
  if (itemRows.length === 0) {
    return []
  }

  const hydratedItems = await hydrateConversationItems(queryable, itemRows)
  const hydratedById = new Map(hydratedItems.map((item) => [item.id, item]))
  const conversationIds = [
    ...new Set(itemRows.map((row) => row.conversation_id)),
  ]
  const participants = await listConversationParticipantRows(
    queryable,
    conversationIds,
    {
      useProfileSnapshot: true,
    }
  )
  const participantById = new Map(
    participants.map((participant) => [participant.id, participant])
  )
  const itemIds = itemRows.map((row) => row.id)
  const contextTargetsResult = await runBuilder(
    queryable,
    queryable
      .selectFrom("conversation_item_context_targets")
      .select(["item_id", "target_participant_id"])
      .where("item_id", "in", itemIds)
      .orderBy("item_id", "asc")
      .orderBy("target_participant_id", "asc")
  )
  const contextTargetIdsByItem = new Map<string, string[]>()
  for (const row of contextTargetsResult.rows) {
    const current = contextTargetIdsByItem.get(row.item_id) ?? []
    current.push(row.target_participant_id)
    contextTargetIdsByItem.set(row.item_id, current)
  }
  const replyToIds = [
    ...new Set(
      itemRows
        .map((row) => row.reply_to_item_id)
        .filter((replyToItemId): replyToItemId is string =>
          Boolean(replyToItemId)
        )
    ),
  ]
  const replyRows = await listItemRowsByIds(queryable, replyToIds)
  const replyHydrated = await hydrateConversationItems(queryable, replyRows)
  const replyRowById = new Map(replyRows.map((row) => [row.id, row]))
  const replyHydratedById = new Map(
    replyHydrated.map((item) => [item.id, item])
  )
  const replyRefById = new Map<string, ConversationReplyRef>()
  for (const replyToItemId of replyToIds) {
    const replyRow = replyRowById.get(replyToItemId)
    const replyItem = replyHydratedById.get(replyToItemId)
    if (
      !replyRow ||
      !replyItem ||
      replyRow.scope !== "shared" ||
      replyRow.surface !== "visible"
    ) {
      continue
    }
    replyRefById.set(replyToItemId, {
      itemId: replyToItemId,
      ref: buildConversationMessageRef(toNumber(replyRow.sequence)),
      sequence: toNumber(replyRow.sequence),
      itemType: replyRow.item_type,
      subtype: replyRow.subtype,
      author: replyRow.author_participant_id
        ? participantRowToEntityRef(
            participantById.get(replyRow.author_participant_id)
          )
        : undefined,
      previewText: replyItem.content.trim(),
      previewBlocks: replyItem.contentBlocks,
      createdAt: serializeInstant(replyRow.created_at),
    })
  }

  return itemRows.map((row) => {
    const hydrated = hydratedById.get(row.id)
    if (!hydrated) {
      throw new Error(`Failed to hydrate conversation item ${row.id}`)
    }
    const restrictedAudienceParticipants =
      hydrated.restrictedAudienceParticipantIds
        .map((participantId) => participantById.get(participantId))
        .filter((participant): participant is ParticipantRow =>
          Boolean(participant)
        )
    const contextTargets = (contextTargetIdsByItem.get(row.id) ?? [])
      .map((participantId) => participantById.get(participantId))
      .filter((participant): participant is ParticipantRow =>
        Boolean(participant)
      )
    const baseItem = {
      id: row.id,
      conversationId: row.conversation_id,
      sessionId: row.session_id ?? undefined,
      turnId: row.turn_id ?? undefined,
      sequence: toNumber(row.sequence),
      scope: row.scope,
      surface: row.surface,
      role: row.role,
      authorParticipantId: row.author_participant_id ?? undefined,
      authorParticipant: row.author_participant_id
        ? participantById.get(row.author_participant_id)
        : undefined,
      restrictedAudienceParticipants,
      contextTargets,
      contentBlocks: hydrated.contentBlocks,
      metadata: asJsonRecord(row.metadata),
      replyToItemId: row.reply_to_item_id ?? undefined,
      replyTo: row.reply_to_item_id
        ? (replyRefById.get(row.reply_to_item_id) ?? {
            itemId: row.reply_to_item_id,
            itemType: "message",
            subtype: "unavailable",
            previewText: "",
            previewBlocks: [],
            isUnavailable: true,
          })
        : undefined,
      causedByItemId: row.caused_by_item_id ?? undefined,
      createdAt: serializeInstant(row.created_at),
      clientMessageId: row.client_message_id ?? undefined,
    } satisfies ConversationItemDetailBase

    if (row.item_type === "event") {
      if (!isConversationEventType(row.subtype)) {
        throw new Error(
          `Unsupported conversation event subtype ${row.subtype} for item ${row.id}`
        )
      }

      return {
        ...baseItem,
        itemType: "event",
        subtype: row.subtype,
        eventPayload: asConversationFeedEventPayload(
          row.subtype,
          row.event_payload
        ),
        eventTimelinePolicy:
          (row.event_timeline_policy as ConversationEventTimelinePolicy | null) ??
          undefined,
        eventContextPolicy:
          (row.event_context_policy as ConversationEventContextPolicy | null) ??
          undefined,
      } satisfies ConversationEventItemDetail
    }

    if (row.item_type !== "summary") {
      assertConversationMessageSubtype(row.subtype)
    } else if (row.subtype !== "summary") {
      throw new Error(
        `Unsupported conversation summary subtype ${row.subtype} for item ${row.id}`
      )
    }

    return {
      ...baseItem,
      itemType: row.item_type,
      subtype: row.subtype,
    } satisfies ConversationNonEventItemDetail
  })
}

function participantRowToEntityRef(
  participant: ParticipantRow | undefined
): ConversationEntityRef | undefined {
  if (!participant) {
    return undefined
  }
  const transportKind = asParticipantTransportKind(participant.transport_kind)
  return {
    participantId: participant.id,
    participantType: subjectKindToParticipantType(participant.participant_type),
    workspaceMemberId: participant.workspace_member_id ?? undefined,
    actorId: participant.actor_id ?? undefined,
    remoteAgentId: participant.remote_agent_id ?? undefined,
    externalUserKey:
      transportKind && participant.transport_external_id
        ? `${transportKind}:${participant.transport_external_id}`
        : undefined,
    transportAddressId: participant.transport_address_id ?? undefined,
    transportKind,
    name: participantDisplayName(participant),
    title: participant.participant_title ?? undefined,
    role: participant.participant_role ?? participant.role_key,
    avatarUrl: participantAvatarUrl(participant),
    avatarEmoji: participantAvatarEmoji(participant),
  }
}

function participantRowToChatParticipantSummary(
  participant: ParticipantRow
): ChatParticipantSummary {
  const entity = participantRowToEntityRef(participant)
  if (!entity) {
    throw new Error(`Failed to map participant ${participant.id}`)
  }
  return {
    participantId: participant.id,
    conversationId: participant.conversation_id,
    participantType: subjectKindToParticipantType(participant.participant_type),
    workspaceMemberId: entity.workspaceMemberId,
    actorId: entity.actorId,
    remoteAgentId: entity.remoteAgentId,
    externalUserKey: entity.externalUserKey,
    transportAddressId: entity.transportAddressId,
    transportKind: entity.transportKind,
    name: entity.name ?? participantDisplayName(participant),
    title: entity.title,
    role: entity.role,
    avatarUrl: entity.avatarUrl,
    avatarEmoji: entity.avatarEmoji,
    roleKey: participant.role_key,
    state: participant.state,
    metadata: asJsonRecord(participant.metadata),
    joinedAt: serializeInstant(participant.joined_at),
    leftAt: serializeOptionalInstant(participant.left_at),
    sessionId: participant.session_id ?? undefined,
    sessionStatus: participant.session_status ?? undefined,
  } satisfies ChatParticipantSummary
}

function conversationItemDetailToChatItem(
  item: ConversationItemDetail,
  transportDeliveries: ConversationMessageTransportDelivery[] = []
): ChatConversationItem {
  const author = participantRowToEntityRef(item.authorParticipant)
  const restrictedAudience = item.restrictedAudienceParticipants
    .map((participant) => participantRowToEntityRef(participant))
    .filter((participant): participant is ConversationEntityRef =>
      Boolean(participant)
    )
  const baseItem = {
    id: item.id,
    conversationId: item.conversationId,
    sequence: item.sequence,
    sessionId: item.sessionId,
    turnId: item.turnId,
    clientMessageId: item.clientMessageId,
    itemType: item.itemType,
    role: item.role,
    scope: item.scope,
    surface: item.surface,
    authorParticipantId: item.authorParticipantId,
    author,
    replyToItemId: item.replyToItemId,
    replyTo: item.replyTo,
    causedByItemId: item.causedByItemId,
    content: extractText(item.contentBlocks),
    contentBlocks: item.contentBlocks,
    metadata: item.metadata,
    restrictedAudienceParticipantIds:
      item.restrictedAudienceParticipants.length > 0
        ? item.restrictedAudienceParticipants.map(
            (participant) => participant.id
          )
        : undefined,
    restrictedAudience:
      restrictedAudience.length > 0 ? restrictedAudience : undefined,
    createdAt: assertIsoInstant(item.createdAt),
  }

  if (item.itemType === CONVERSATION_ITEM_TYPE.EVENT) {
    return {
      ...baseItem,
      itemType: "event",
      subtype: item.subtype,
      eventPayload: item.eventPayload,
      eventTimelinePolicy: item.eventTimelinePolicy,
      eventContextPolicy: item.eventContextPolicy,
    } as ChatConversationEventItem
  }

  return {
    ...baseItem,
    itemType: item.itemType,
    subtype: item.subtype,
    transport: mapTransportContext(item.metadata),
    transportDeliveries,
  } satisfies ChatConversationItem
}

async function buildChatConversationItems(
  queryable: Executor,
  itemRows: ItemRow[],
  options?: { includeTransportDeliveries?: boolean }
) {
  if (itemRows.length === 0) {
    return [] as ChatConversationItem[]
  }

  const details = await buildConversationItemDetails(queryable, itemRows)
  const deliveriesByItem = options?.includeTransportDeliveries
    ? await loadTransportDeliveriesForItems(
        queryable,
        details.map((item) => item.id)
      )
    : new Map<string, ConversationMessageTransportDelivery[]>()

  return details.map((detail) =>
    conversationItemDetailToChatItem(
      detail,
      deliveriesByItem.get(detail.id) ?? []
    )
  )
}

function conversationEventDetailToFeedItem<T extends ConversationFeedEventType>(
  item: ConversationEventItemDetail<T>,
  author: ConversationEntityRef | undefined,
  restrictedAudience: ConversationEntityRef[]
): ConversationFeedEventItem<T> {
  return {
    kind: "event",
    itemId: item.id,
    conversationId: item.conversationId,
    sequence: item.sequence,
    sessionId: item.sessionId,
    turnId: item.turnId,
    author,
    restrictedAudience:
      restrictedAudience.length > 0 ? restrictedAudience : undefined,
    causedByItemId: item.causedByItemId,
    eventType: item.subtype,
    payload: item.eventPayload,
    createdAt: assertIsoInstant(item.createdAt),
  } as ConversationFeedEventItem<T>
}

function mapTransportContext(
  metadata: Record<string, unknown>
): ConversationMessageTransportContext | undefined {
  const raw = metadata.transport
  if (!raw || typeof raw !== "object") {
    return undefined
  }
  const value = raw as Record<string, unknown>
  const direction =
    value.direction === "inbound" || value.direction === "outbound"
      ? value.direction
      : undefined
  const transportKind = isTransportKind(value.transportKind)
    ? value.transportKind
    : undefined
  if (!direction || !transportKind) {
    return undefined
  }
  return {
    direction,
    transportKind,
    transportAccountId:
      typeof value.transportAccountId === "string"
        ? value.transportAccountId
        : undefined,
    endpointType:
      value.endpointType === "direct" || value.endpointType === "group"
        ? value.endpointType
        : undefined,
    endpointExternalId:
      typeof value.endpointExternalId === "string"
        ? value.endpointExternalId
        : undefined,
    externalMessageId:
      typeof value.externalMessageId === "string"
        ? value.externalMessageId
        : undefined,
    transportAddressId:
      typeof value.transportAddressId === "string"
        ? value.transportAddressId
        : undefined,
    senderExternalId:
      typeof value.senderExternalId === "string"
        ? value.senderExternalId
        : undefined,
  }
}

async function loadTransportDeliveriesForItems(
  queryable: Executor,
  itemIds: string[]
) {
  if (itemIds.length === 0) {
    return new Map<string, ConversationMessageTransportDelivery[]>()
  }
  const result = await runOn<{
    item_id: string
    link_id: string
    transport_kind: TransportKind
    direction: "inbound" | "outbound"
    delivery_status: "pending" | "sent" | "failed" | "skipped"
    external_message_id: string | null
    metadata: unknown
    delivered_at: Date | null
    endpoint_type: "direct" | "group"
    endpoint_external_id: string | null
    endpoint_display_name: string | null
  }>(
    queryable,
    `
      SELECT
        tml.item_id,
        tml.id AS link_id,
        tml.transport_kind,
        tml.direction,
        tml.delivery_status,
        tml.external_message_id,
        tml.metadata,
        tml.delivered_at,
        te.endpoint_type,
        te.external_id AS endpoint_external_id,
        te.display_name AS endpoint_display_name
      FROM transport_message_links tml
      INNER JOIN transport_endpoints te
        ON te.id = tml.transport_endpoint_id
      WHERE tml.item_id = ANY($1::uuid[])
      ORDER BY tml.item_id ASC, tml.created_at ASC
    `,
    [itemIds]
  )
  const byItem = new Map<string, ConversationMessageTransportDelivery[]>()
  for (const row of result.rows) {
    const current = byItem.get(row.item_id) ?? []
    current.push({
      linkId: row.link_id,
      transportKind: row.transport_kind,
      direction: row.direction,
      deliveryStatus: row.delivery_status,
      endpointType: row.endpoint_type,
      endpointExternalId: row.endpoint_external_id ?? undefined,
      endpointDisplayName: row.endpoint_display_name ?? undefined,
      externalMessageId: row.external_message_id ?? undefined,
      deliveredAt: serializeOptionalInstant(row.delivered_at),
      metadata: asJsonRecord(row.metadata),
    })
    byItem.set(row.item_id, current)
  }
  return byItem
}

export function conversationItemDetailToFeedItem(
  item: ConversationItemDetail,
  transportDeliveries: ConversationMessageTransportDelivery[] = []
): ConversationFeedItem {
  const author = participantRowToEntityRef(item.authorParticipant)
  const restrictedAudience = item.restrictedAudienceParticipants
    .map((participant) => participantRowToEntityRef(participant))
    .filter((participant): participant is ConversationEntityRef =>
      Boolean(participant)
    )

  if (item.itemType === CONVERSATION_ITEM_TYPE.EVENT) {
    return conversationEventDetailToFeedItem(item, author, restrictedAudience)
  }

  if (item.itemType !== "summary") {
    assertConversationMessageSubtype(item.subtype)
  }

  return {
    kind: "message",
    itemId: item.id,
    conversationId: item.conversationId,
    sequence: item.sequence,
    sessionId: item.sessionId,
    turnId: item.turnId,
    role: item.role === "tool" ? "system" : item.role,
    messageType: item.subtype,
    author,
    replyToItemId: item.replyToItemId,
    replyTo: item.replyTo,
    restrictedAudience:
      restrictedAudience.length > 0 ? restrictedAudience : undefined,
    content: extractText(item.contentBlocks),
    contentBlocks: item.contentBlocks,
    metadata: item.metadata,
    transport: mapTransportContext(item.metadata),
    transportDeliveries,
    createdAt: assertIsoInstant(item.createdAt),
    clientMessageId: item.clientMessageId,
  } satisfies ConversationFeedMessageItem
}

export function isFeedItemVisibleToWorkspaceMember(
  item: ConversationFeedItem,
  workspaceMemberId: string
) {
  if (item.kind === "message") {
    if (item.messageType === "model_error_notice") {
      if (!item.restrictedAudience || item.restrictedAudience.length === 0) {
        return true
      }
      if (item.author?.workspaceMemberId === workspaceMemberId) {
        return true
      }
      return item.restrictedAudience.some(
        (target) => target.workspaceMemberId === workspaceMemberId
      )
    }
    return true
  }

  if (!item.restrictedAudience || item.restrictedAudience.length === 0) {
    return true
  }
  if (item.author?.workspaceMemberId === workspaceMemberId) {
    return true
  }
  return item.restrictedAudience.some(
    (target) => target.workspaceMemberId === workspaceMemberId
  )
}

export async function getConversationFeedItemById(
  itemId: string,
  queryable: Executor = rootQueryable()
) {
  const rows = await runOn<ItemRow>(
    queryable,
    `
      SELECT
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
        reply_to_item_id,
        caused_by_item_id,
        event_payload,
        event_timeline_policy,
        event_context_policy,
        metadata,
        sequence,
        created_at
      FROM conversation_items
      WHERE id = $1
      LIMIT 1
    `,
    [itemId]
  )
  const row = rows.rows[0]
  if (!row) {
    return null
  }
  const [detail] = await buildConversationItemDetails(queryable, [row])
  if (!detail) {
    return null
  }
  const deliveries = await loadTransportDeliveriesForItems(queryable, [
    detail.id,
  ])
  return conversationItemDetailToFeedItem(
    detail,
    deliveries.get(detail.id) ?? []
  )
}

export async function getContextConversationItemsForParticipant(params: {
  conversationId: string
  participantId: string
  beforeSequence?: number
  limit?: number
  queryable?: Executor
}) {
  const queryable = params.queryable ?? rootQueryable()
  const result = await runOn<ItemRow>(
    queryable,
    `
      SELECT
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
        reply_to_item_id,
        caused_by_item_id,
        event_payload,
        event_timeline_policy,
        event_context_policy,
        metadata,
        sequence,
        created_at
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
      params.conversationId,
      params.participantId,
      params.beforeSequence ?? null,
      Math.max(1, Math.min(params.limit ?? 200, 500)),
    ]
  )
  const rows = [...result.rows].reverse()
  return buildConversationItemDetails(queryable, rows)
}

export async function getLastVisibleConversationItem(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  const result = await runOn<ItemRow>(
    queryable,
    `
      SELECT
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
        reply_to_item_id,
        caused_by_item_id,
        event_payload,
        event_timeline_policy,
        event_context_policy,
        metadata,
        sequence,
        created_at
      FROM conversation_items
      WHERE conversation_id = $1
        AND scope = 'shared'
        AND surface = 'visible'
      ORDER BY sequence DESC
      LIMIT 1
    `,
    [conversationId]
  )
  const row = result.rows[0]
  if (!row) {
    return null
  }
  const [detail] = await buildConversationItemDetails(queryable, [row])
  return detail ?? null
}

export async function listWorkspaceConversationViews(params: {
  workspaceId: string
  workspaceMemberId: string
  queryable?: Executor
}) {
  return loadConversationViews(
    params.queryable ?? rootQueryable(),
    params.workspaceId,
    params.workspaceMemberId
  )
}

export async function listConversationRealtimeRecipients(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  const result = await runOn<{
    workspace_id: string
    workspace_member_id: string
  }>(
    queryable,
    `
      SELECT wm.workspace_id, cpsubj.workspace_member_id
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

  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    workspaceMemberId: row.workspace_member_id,
  }))
}

export async function createChatClientInstance(params: {
  workspaceId: string
  userId: string
  platform?: string
  deviceLabel?: string
  metadata?: Record<string, unknown>
}): Promise<ChatClientInstanceRegistrationResponse> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const clientInstanceId = await withDbTransaction(async (client) =>
    createClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      platform: params.platform,
      deviceLabel: params.deviceLabel,
      metadata: params.metadata,
    })
  )

  return {
    clientInstanceId,
    workspaceMemberId: identity.workspaceMemberId,
  }
}

export async function touchChatClientInstance(params: {
  workspaceId: string
  userId: string
  clientInstanceId: string
  platform?: string
  deviceLabel?: string
  metadata?: Record<string, unknown>
}): Promise<ChatClientInstanceRegistrationResponse> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  await withDbTransaction(async (client) => {
    await touchClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: identity.workspaceMemberId,
      clientInstanceId: params.clientInstanceId,
      platform: params.platform,
      deviceLabel: params.deviceLabel,
      metadata: params.metadata,
    })
  })

  return {
    clientInstanceId: params.clientInstanceId,
    workspaceMemberId: identity.workspaceMemberId,
  }
}

export async function createChatConversation(params: {
  workspaceId: string
  userId: string
  clientRequestId: string
  kind: ConversationKind
  title?: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  metadata?: Record<string, unknown>
}): Promise<ChatConversationCreateResponse> {
  const creator = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const workspaceMemberIds = [
    ...new Set([
      creator.workspaceMemberId,
      ...(params.workspaceMemberIds ?? []),
    ]),
  ]
  const actorIds = [...new Set(params.actorIds ?? [])]
  const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]
  // External participants are not creatable through this public path; they are
  // minted only by the IM ingest path (syncTransportAddressConversationParticipant).

  const conversationId = await withDbTransaction(async (client) => {
    const existingRequest = await runOn<{ conversation_id: string }>(
      client,
      `
        SELECT conversation_id
        FROM chat_conversation_create_requests
        WHERE workspace_member_id = $1
          AND client_request_id = $2
        LIMIT 1
      `,
      [creator.workspaceMemberId, params.clientRequestId]
    )
    if (existingRequest.rows[0]?.conversation_id) {
      return existingRequest.rows[0].conversation_id
    }

    const memberRows = await loadWorkspaceMembersByIds(
      client,
      params.workspaceId,
      workspaceMemberIds
    )
    if (memberRows.length !== workspaceMemberIds.length) {
      throw createChatError(
        400,
        "invalid_workspace_member",
        "One or more workspace members are invalid"
      )
    }

    const actorRows = await loadActorsByIds(
      client,
      params.workspaceId,
      actorIds
    )
    if (actorRows.length !== actorIds.length) {
      throw createChatError(
        400,
        "invalid_actor",
        "One or more actors are invalid"
      )
    }

    const remoteAgentRows = await loadRemoteAgentsByIds(
      client,
      params.workspaceId,
      remoteAgentIds
    )
    if (remoteAgentRows.length !== remoteAgentIds.length) {
      throw createChatError(
        400,
        "invalid_remote_agent",
        "One or more remote agents are invalid"
      )
    }

    const newConversationId = crypto.randomUUID()
    await client
      .insertInto("conversations")
      .values({
        id: newConversationId,
        kind: params.kind,
        workspace_id: params.workspaceId,
        title: params.title?.trim() || null,
        created_by_workspace_member_id: creator.workspaceMemberId,
        metadata: jsonbValue(params.metadata ?? {}),
        created_at: sql`NOW()`,
      })
      .execute()

    for (const member of memberRows) {
      await insertParticipant(client, {
        conversationId: newConversationId,
        participantType: "workspace_member",
        workspaceMemberId: member.id,
        displayName: member.user_name,
        roleKey: member.id === creator.workspaceMemberId ? "owner" : "member",
        metadata: {},
      })
      await upsertConversationView(client, {
        workspaceMemberId: member.id,
        conversationId: newConversationId,
        unreadCount: 0,
      })
    }

    for (const actor of actorRows) {
      await insertParticipant(client, {
        conversationId: newConversationId,
        participantType: "actor",
        actorId: actor.id,
        displayName: actor.display_name,
        roleKey: "member",
        metadata: {},
      })
    }

    for (const remoteAgent of remoteAgentRows) {
      await insertParticipant(client, {
        conversationId: newConversationId,
        participantType: "remote_agent",
        remoteAgentId: remoteAgent.id,
        displayName: remoteAgent.display_name,
        roleKey: "member",
        metadata: {},
      })
    }

    await client
      .insertInto("chat_conversation_create_requests")
      .values({
        workspace_member_id: creator.workspaceMemberId,
        client_request_id: params.clientRequestId,
        workspace_id: params.workspaceId,
        conversation_id: newConversationId,
        created_at: sql`NOW()`,
      })
      .execute()

    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      memberRows.map((row) => row.id),
      newConversationId
    )

    return newConversationId
  })

  const conversation = await loadConversationView(
    rootQueryable(),
    params.workspaceId,
    creator.workspaceMemberId,
    conversationId
  )

  if (!conversation) {
    throw createChatError(
      500,
      "conversation_load_failed",
      "Failed to load created conversation"
    )
  }

  return {
    conversation,
  }
}

export async function getChatBootstrap(params: {
  workspaceId: string
  userId: string
}): Promise<ChatBootstrapResponse> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  // Read the conversation projection AND the cursor in ONE repeatable-read
  // snapshot. Otherwise an event committing between the two reads could push
  // the cursor past a state the projection didn't include (e.g. a removal at
  // member_seq=N+1 commits after we read conversations but before we read the
  // cursor) — the client would then tombstone at a boundary that resurrects a
  // stale higher-seq upsert. A single snapshot makes the projection strictly
  // consistent with nextInboxCursor.
  const { conversations, nextInboxCursor } = await db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const conversations = await loadConversationViews(
        trx,
        params.workspaceId,
        identity.workspaceMemberId
      )
      const nextInboxCursor = await getCurrentSyncCursor(
        trx,
        params.workspaceId,
        identity.workspaceMemberId
      )
      return { conversations, nextInboxCursor }
    })

  return {
    workspaceMemberId: identity.workspaceMemberId,
    clientInstanceRequired: true,
    conversations,
    nextInboxCursor,
  }
}

export async function getChatSync(params: {
  workspaceId: string
  userId: string
  cursor?: number
  limit?: number
}): Promise<ChatSyncResponse> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500)
  const result = await runOn<{
    sync_seq: string | number
    member_seq: string | number
    workspace_id: string
    workspace_member_id: string
    conversation_id: string | null
    item_id: string | null
    event_type: ChatSyncEventType
    payload: unknown
    occurred_at: Date
  }>(
    db,
    `
      SELECT
        sync_seq,
        member_seq,
        workspace_id,
        workspace_member_id,
        conversation_id,
        item_id,
        event_type,
        payload,
        occurred_at
      FROM workspace_member_sync_events
      WHERE workspace_id = $1
        AND workspace_member_id = $2
        AND member_seq > $3
      ORDER BY member_seq ASC
      LIMIT $4
    `,
    [
      params.workspaceId,
      identity.workspaceMemberId,
      params.cursor ?? 0,
      limit + 1,
    ]
  )

  const hasMore = result.rows.length > limit
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows
  const events: ChatSyncEvent[] = await Promise.all(
    rows.map(async (row) => {
      const eventType = row.event_type
      const payload = asChatSyncEventPayload(eventType, row.payload)
      const enrichedPayload = await enrichChatSyncEventPayloadForViewer(
        eventType,
        payload,
        identity.userId
      )
      return {
        syncSeq: toNumber(row.sync_seq),
        memberSeq: toNumber(row.member_seq),
        workspaceId: row.workspace_id,
        workspaceMemberId: row.workspace_member_id,
        conversationId: row.conversation_id ?? undefined,
        itemId: row.item_id ?? undefined,
        eventType,
        payload: enrichedPayload,
        occurredAt: serializeInstant(row.occurred_at),
      }
    })
  )

  return {
    events,
    nextCursor:
      events.length > 0
        ? events[events.length - 1]!.memberSeq
        : (params.cursor ?? 0),
    hasMore,
  }
}

export async function getChatConversationMessages(params: {
  workspaceId: string
  userId: string
  conversationId: string
  afterSequence?: number
  beforeSequence?: number
  limit?: number
  clientInstanceId: string
}): Promise<ChatConversationMessagesPage> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const access = await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )

  await ensureClientInstance(rootQueryable(), {
    workspaceId: params.workspaceId,
    workspaceMemberId: identity.workspaceMemberId,
    clientInstanceId: params.clientInstanceId,
  })

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200)
  let rows: ItemRow[] = []
  let hasMoreBefore = false
  let hasMoreAfter = false
  if (typeof params.afterSequence === "number") {
    const result = await runOn<ItemRow>(
      db,
      `
        SELECT
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
          reply_to_item_id,
          caused_by_item_id,
          event_payload,
          event_timeline_policy,
          event_context_policy,
          metadata,
          sequence,
          created_at
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
        params.conversationId,
        params.afterSequence,
        access.participant.id,
        limit + 1,
      ]
    )
    hasMoreAfter = result.rows.length > limit
    hasMoreBefore = params.afterSequence > 0
    rows = hasMoreAfter ? result.rows.slice(0, limit) : result.rows
  } else if (typeof params.beforeSequence === "number") {
    const result = await runOn<ItemRow>(
      db,
      `
        SELECT
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
          reply_to_item_id,
          caused_by_item_id,
          event_payload,
          event_timeline_policy,
          event_context_policy,
          metadata,
          sequence,
          created_at
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
        params.conversationId,
        params.beforeSequence,
        access.participant.id,
        limit + 1,
      ]
    )
    hasMoreBefore = result.rows.length > limit
    hasMoreAfter = true
    rows = (hasMoreBefore ? result.rows.slice(0, limit) : result.rows).reverse()
  } else {
    const result = await runOn<ItemRow>(
      db,
      `
        SELECT
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
          reply_to_item_id,
          caused_by_item_id,
          event_payload,
          event_timeline_policy,
          event_context_policy,
          metadata,
          sequence,
          created_at
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
      [params.conversationId, access.participant.id, limit + 1]
    )
    hasMoreBefore = result.rows.length > limit
    rows = (hasMoreBefore ? result.rows.slice(0, limit) : result.rows).reverse()
  }

  const items = await buildChatConversationItems(rootQueryable(), rows, {
    includeTransportDeliveries: true,
  })
  const enrichedItems = await enrichChatConversationItemsForViewer(
    items,
    identity.userId
  )

  const conversation = await loadConversationView(
    rootQueryable(),
    params.workspaceId,
    identity.workspaceMemberId,
    params.conversationId
  )
  if (!conversation) {
    throw createChatError(
      404,
      "conversation_not_found",
      "Conversation not found"
    )
  }

  const readState = await runOn<{
    read_watermark_sequence: string | number
  }>(
    db,
    `
      SELECT read_watermark_sequence
      FROM conversation_participant_states
      WHERE conversation_id = $1
        AND participant_id = $2
      LIMIT 1
    `,
    [params.conversationId, access.participant.id]
  )

  const deviceStateResult = await runOn<{
    client_instance_id: string
    conversation_id: string
    last_visible_sequence: string | number
    last_inbox_seq: string | number
    last_opened_at: Date | null
    draft_payload: unknown
  }>(
    db,
    `
      SELECT
        client_instance_id,
        conversation_id,
        last_visible_sequence,
        last_inbox_seq,
        last_opened_at,
        draft_payload
      FROM conversation_device_states
      WHERE conversation_id = $1
        AND client_instance_id = $2
      LIMIT 1
    `,
    [params.conversationId, params.clientInstanceId]
  )
  const row = deviceStateResult.rows[0]
  const deviceState: ChatDeviceState = row
    ? {
        clientInstanceId: row.client_instance_id,
        conversationId: row.conversation_id,
        lastVisibleSequence: toNumber(row.last_visible_sequence),
        lastInboxSeq: toNumber(row.last_inbox_seq),
        lastOpenedAt: serializeOptionalInstant(row.last_opened_at),
        draftPayload: asJsonRecord(row.draft_payload),
      }
    : {
        clientInstanceId: params.clientInstanceId,
        conversationId: params.conversationId,
        lastVisibleSequence: 0,
        lastInboxSeq: 0,
        draftPayload: {},
      }

  const runtimeMap = await getConversationRuntimeMap([params.conversationId])
  const remoteAgentIds = conversation.participants
    .filter(
      (participant) =>
        participant.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    )
    .map((participant) => participant.remoteAgentId)
    .filter((value): value is string => Boolean(value))
  const runtimeByRemoteAgent: Record<string, any> = {}
  if (remoteAgentIds.length > 0) {
    const { loadRemoteAgentRuntimeSnapshot } =
      await import("../remote-agents/service.js")
    for (const remoteAgentId of remoteAgentIds) {
      // Pass the chat's conversationId so the snapshot reflects this
      // conversation's runtime state, not whichever sibling conversation
      // happened to win the global LATERAL pick in the snapshot SQL.
      // Core execution is already per-conversation; this completes the
      // user-visible isolation.
      const snapshot = await loadRemoteAgentRuntimeSnapshot(remoteAgentId, {
        conversationId: params.conversationId,
      })
      if (snapshot) {
        runtimeByRemoteAgent[remoteAgentId] = snapshot
      }
    }
  }

  return {
    conversation,
    items: enrichedItems,
    runtimeByActor: runtimeMap[params.conversationId] || {},
    runtimeByRemoteAgent,
    participantReadWatermarkSequence: toNumber(
      readState.rows[0]?.read_watermark_sequence
    ),
    deviceState,
    hasMoreBefore,
    hasMoreAfter,
  }
}

export async function requireRemoteAgentConversationAccess(
  queryable: Executor,
  conversationId: string,
  remoteAgentId: string
) {
  const participant = await getConversationParticipant({
    conversationId,
    remoteAgentId,
    queryable,
  })
  if (!participant || participant.state !== "active") {
    throw createChatError(
      403,
      "conversation_access_denied",
      "Remote agent is not an active participant in this conversation"
    )
  }
  return { participant }
}

export async function listVisibleConversationItemsForParticipant(params: {
  conversationId: string
  participantId: string
  afterSequence?: number
  beforeSequence?: number
  limit?: number
  queryable?: Executor
}) {
  const queryable = params.queryable ?? rootQueryable()
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200)
  let rows: ItemRow[] = []

  if (typeof params.afterSequence === "number") {
    const result = await runOn<ItemRow>(
      queryable,
      `
        SELECT
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
          reply_to_item_id,
          caused_by_item_id,
          event_payload,
          event_timeline_policy,
          event_context_policy,
          metadata,
          sequence,
          created_at
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
      [params.conversationId, params.afterSequence, params.participantId, limit]
    )
    rows = result.rows
  } else if (typeof params.beforeSequence === "number") {
    const result = await runOn<ItemRow>(
      queryable,
      `
        SELECT
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
          reply_to_item_id,
          caused_by_item_id,
          event_payload,
          event_timeline_policy,
          event_context_policy,
          metadata,
          sequence,
          created_at
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
        params.conversationId,
        params.beforeSequence,
        params.participantId,
        limit,
      ]
    )
    rows = [...result.rows].reverse()
  } else {
    const result = await runOn<ItemRow>(
      queryable,
      `
        SELECT
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
          reply_to_item_id,
          caused_by_item_id,
          event_payload,
          event_timeline_policy,
          event_context_policy,
          metadata,
          sequence,
          created_at
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
      [params.conversationId, params.participantId, limit]
    )
    rows = [...result.rows].reverse()
  }

  return buildChatConversationItems(queryable, rows, {
    includeTransportDeliveries: true,
  })
}

export async function getChatConversationActorRuntimeTurnDetail(params: {
  workspaceId: string
  userId: string
  conversationId: string
  actorId: string
  turnId: string
}): Promise<ActorRuntimeTurnActivityDetail> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )

  const detail = await getSessionRuntimeTurnActivityDetail({
    conversationId: params.conversationId,
    actorId: params.actorId,
    turnId: params.turnId,
  })
  if (!detail) {
    throw createChatError(
      404,
      "runtime_turn_not_found",
      "Current turn activity not found"
    )
  }

  return detail
}

export async function sendChatConversationMessage(
  params: SendMessageInput
): Promise<ChatConversationSendMessageResponse> {
  const contentBlocks = params.contentBlocks
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    throw createChatError(
      400,
      "invalid_content_blocks",
      "contentBlocks is required"
    )
  }

  const item = await withDbTransaction(async (client) => {
    const access = await requireConversationAccess(
      client,
      params.conversationId,
      params.workspaceMemberId
    )

    await ensureClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      clientInstanceId: params.clientInstanceId,
    })

    return sendConversationMessageFromParticipant({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      senderParticipantId: access.participant.id,
      clientMessageId: params.clientMessageId,
      role: "user",
      contentBlocks,
      replyToItemId: params.replyToItemId,
      metadata: params.metadata,
      queryable: client,
    })
  })

  await enqueueActorWakeupsForConversationMessage({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    itemId: item.id,
  })
  const { notifyRemoteAgentDeliveriesForConversation } =
    await import("../remote-agents/service.js")
  await notifyRemoteAgentDeliveriesForConversation(params.conversationId)

  return {
    item,
  }
}

export async function updateChatConversationReadWatermark(
  params: ReadWatermarkInput
): Promise<ChatConversationReadWatermarkResponse> {
  return withDbTransaction(async (client) => {
    const access = await requireConversationAccess(
      client,
      params.conversationId,
      params.workspaceMemberId
    )

    await ensureClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      clientInstanceId: params.clientInstanceId,
    })

    const maxSequence = await getConversationSequenceMax(
      client,
      params.conversationId
    )
    const requestedSequence = Math.min(
      Math.max(params.readUpToSequence, 0),
      maxSequence
    )

    const existingState = await runOn<{
      read_watermark_sequence: string | number
      last_read_at: Date | null
    }>(
      client,
      `
        SELECT read_watermark_sequence, last_read_at
        FROM conversation_participant_states
        WHERE conversation_id = $1
          AND participant_id = $2
        LIMIT 1
      `,
      [params.conversationId, access.participant.id]
    )
    const existingRow = existingState.rows[0]
    const existingSequence = toNumber(existingRow?.read_watermark_sequence)
    const nextSequence = Math.max(existingSequence, requestedSequence)
    // S6 dedup observability: if the request didn't actually advance the
    // watermark, it's a duplicate POST — the main thread and the SW
    // both flushed the same pending-read. Count it so we can monitor
    // whether the mutex (isChatServiceWorkerActive guard, S23) is
    // holding.
    //
    // S37: require an EXISTING USER-INITIATED watermark before counting.
    // Adding a participant pre-inserts a row with sequence=0 and
    // last_read_at=NULL (see ensureConversationParticipant). The user's
    // first POST with readUpTo=0 collides with that pre-initialized row
    // but isn't actually a duplicate — it's the inaugural mark. Use
    // last_read_at as the "user has marked something before" signal.
    const userHasMarkedBefore =
      Boolean(existingRow) && existingRow!.last_read_at !== null
    if (userHasMarkedBefore && nextSequence === existingSequence) {
      recordDuplicateWatermarkPost()
    }
    const lastReadItemId = await getLastItemAtOrBeforeSequence(
      client,
      params.conversationId,
      nextSequence
    )

    await client
      .insertInto("conversation_participant_states")
      .values({
        conversation_id: params.conversationId,
        participant_id: access.participant.id,
        read_watermark_sequence: nextSequence,
        last_read_item_id: lastReadItemId,
        last_read_at: sql`NOW()`,
        created_at: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(["conversation_id", "participant_id"]).doUpdateSet({
          read_watermark_sequence: sql`GREATEST(conversation_participant_states.read_watermark_sequence, EXCLUDED.read_watermark_sequence)`,
          last_read_item_id: sql`EXCLUDED.last_read_item_id`,
          last_read_at: sql`NOW()`,
        })
      )
      .execute()

    if (params.clientInstanceId) {
      const lastVisibleSequence = Math.min(
        maxSequence,
        Math.max(params.lastVisibleSequence ?? nextSequence, nextSequence)
      )
      await client
        .insertInto("conversation_device_states")
        .values({
          conversation_id: params.conversationId,
          client_instance_id: params.clientInstanceId,
          last_visible_sequence: lastVisibleSequence,
          last_opened_at: sql`NOW()`,
          last_inbox_seq: 0,
          draft_payload: jsonbValue({}),
          created_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.columns(["conversation_id", "client_instance_id"]).doUpdateSet({
            last_visible_sequence: sql`GREATEST(conversation_device_states.last_visible_sequence, EXCLUDED.last_visible_sequence)`,
            last_opened_at: sql`NOW()`,
          })
        )
        .execute()
    }

    const unreadCount = await countUnreadVisibleMessages(
      client,
      params.conversationId,
      access.participant.id
    )

    await upsertConversationView(client, {
      workspaceMemberId: params.workspaceMemberId,
      conversationId: params.conversationId,
      unreadCount,
    })

    const lastReadAt = serializeNowInstant()
    await appendWorkspaceMemberSyncEvent(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      conversationId: params.conversationId,
      eventType: "conversation.read.updated",
      payload: {
        conversationId: params.conversationId,
        workspaceMemberId: params.workspaceMemberId,
        participantId: access.participant.id,
        readWatermarkSequence: nextSequence,
        lastReadAt,
      },
    })

    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      [params.workspaceMemberId],
      params.conversationId
    )

    return {
      conversationId: params.conversationId,
      workspaceMemberId: params.workspaceMemberId,
      participantId: access.participant.id,
      readWatermarkSequence: nextSequence,
      lastReadAt,
    }
  })
}

// ============ Stage 3: conversation CRUD ============

export async function listChatConversations(params: {
  workspaceId: string
  userId: string
}) {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const conversations = await loadConversationViews(
    rootQueryable(),
    params.workspaceId,
    identity.workspaceMemberId
  )
  return {
    workspaceMemberId: identity.workspaceMemberId,
    conversations,
  }
}

export async function getChatConversationDetail(params: {
  workspaceId: string
  userId: string
  conversationId: string
}) {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const queryable = rootQueryable()
  await requireConversationAccess(
    queryable,
    params.conversationId,
    identity.workspaceMemberId
  )
  const view = await loadConversationView(
    queryable,
    params.workspaceId,
    identity.workspaceMemberId,
    params.conversationId
  )
  if (!view) {
    throw createChatError(
      404,
      "conversation_not_found",
      "Conversation not found"
    )
  }
  return { conversation: view }
}

export async function patchChatConversation(params: {
  workspaceId: string
  userId: string
  conversationId: string
  title?: string | null
  metadata?: Record<string, unknown>
}) {
  if (params.title === undefined && params.metadata === undefined) {
    throw createChatError(
      400,
      "invalid_patch",
      "At least one of title or metadata must be provided"
    )
  }
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return withDbTransaction(async (client) => {
    await requireConversationManagement(
      client,
      params.conversationId,
      identity.workspaceMemberId
    )

    const setFragments: string[] = []
    const values: unknown[] = []
    let position = 1
    if (params.title !== undefined) {
      setFragments.push(`title = $${position++}`)
      values.push(params.title?.trim() || null)
    }
    if (params.metadata !== undefined) {
      setFragments.push(`metadata = $${position++}::jsonb`)
      values.push(JSON.stringify(params.metadata))
    }
    if (setFragments.length === 0) {
      return
    }
    values.push(params.conversationId)

    await runOn(
      client,
      `UPDATE conversations SET ${setFragments.join(", ")} WHERE id = $${position}`,
      values
    )

    const recipients = await listConversationRealtimeRecipients(
      params.conversationId,
      client
    )
    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      recipients.map((r) => r.workspaceMemberId),
      params.conversationId
    )

    const view = await loadConversationView(
      client,
      params.workspaceId,
      identity.workspaceMemberId,
      params.conversationId
    )
    if (!view) {
      throw createChatError(
        404,
        "conversation_not_found",
        "Conversation not found"
      )
    }
    return { conversation: view }
  })
}

export async function addChatConversationParticipants(params: {
  workspaceId: string
  userId: string
  conversationId: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
}) {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return withDbTransaction(async (client) => {
    await requireConversationManagement(
      client,
      params.conversationId,
      identity.workspaceMemberId
    )

    await addConversationParticipants({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      workspaceMemberIds: params.workspaceMemberIds,
      actorIds: params.actorIds,
      remoteAgentIds: params.remoteAgentIds,
      queryable: client,
    })

    const recipients = await listConversationRealtimeRecipients(
      params.conversationId,
      client
    )
    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      recipients.map((r) => r.workspaceMemberId),
      params.conversationId
    )

    const view = await loadConversationView(
      client,
      params.workspaceId,
      identity.workspaceMemberId,
      params.conversationId
    )
    if (!view) {
      throw createChatError(
        404,
        "conversation_not_found",
        "Conversation not found"
      )
    }
    return { conversation: view }
  })
}

async function setParticipantState(
  queryable: Executor,
  participantId: string,
  state: "removed" | "left"
) {
  await queryable
    .updateTable("conversation_participants")
    .set({
      state,
      left_at: sql`COALESCE(left_at, NOW())`,
    })
    .where("id", "=", participantId)
    .execute()
}

// Exported for unit-test coverage; see remove-participant.test.ts. After the
// P1b polymorphic-FK collapse, conversation_participants no longer carries
// workspace_member_id / actor_id / remote_agent_id directly — those projections
// come from access_subjects via cp.subject_id. A regression here would only
// surface at runtime when DELETE /chat/conversations/:cid/participants/:pid
// is hit; a focused test on the SQL keeps it honest.
export async function loadParticipantById(
  queryable: Executor,
  conversationId: string,
  participantId: string
) {
  const result = await runOn<{
    id: string
    conversation_id: string
    participant_type: ParticipantKind
    workspace_member_id: string | null
    actor_id: string | null
    remote_agent_id: string | null
    display_name: string | null
    state: string
  }>(
    queryable,
    `
      SELECT cp.id, cp.conversation_id, cpsubj.kind AS participant_type,
             cpsubj.workspace_member_id AS workspace_member_id,
             cpsubj.actor_id AS actor_id,
             cpsubj.remote_agent_id AS remote_agent_id,
             cp.display_name, cp.state
      FROM conversation_participants cp
      JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
      WHERE cp.conversation_id = $1 AND cp.id = $2
      LIMIT 1
    `,
    [conversationId, participantId]
  )
  return result.rows[0] ?? null
}

export async function removeChatConversationParticipant(params: {
  workspaceId: string
  userId: string
  conversationId: string
  participantId: string
}) {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return withDbTransaction(async (client) => {
    const access = await requireConversationAccess(
      client,
      params.conversationId,
      identity.workspaceMemberId
    )

    const target = await loadParticipantById(
      client,
      params.conversationId,
      params.participantId
    )
    if (!target) {
      throw createChatError(
        404,
        "participant_not_found",
        "Participant not found in this conversation"
      )
    }
    if (target.state !== "active") {
      throw createChatError(
        409,
        "participant_not_active",
        "Participant is already left or removed"
      )
    }

    const isSelfRemoval = target.id === access.participant.id
    // Kicking someone else requires conversation management rights;
    // removing yourself ("leave") only requires being a participant.
    if (!isSelfRemoval) {
      await requireConversationManagement(
        client,
        params.conversationId,
        identity.workspaceMemberId
      )
    }
    const eventType = isSelfRemoval ? "participant_left" : "participant_kicked"

    await setParticipantState(
      client,
      target.id,
      isSelfRemoval ? "left" : "removed"
    )

    await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType,
      authorParticipantId: access.participant.id,
      eventPayload: {
        batchId: crypto.randomUUID(),
        initiator: isSelfRemoval
          ? undefined
          : {
              participantId: access.participant.id,
              participantType: access.participant
                .participant_type as ParticipantKind,
              workspaceMemberId: identity.workspaceMemberId,
            },
        participants: [
          {
            participantId: target.id,
            participantType: target.participant_type as Exclude<
              ParticipantKind,
              "system"
            >,
            workspaceMemberId: target.workspace_member_id ?? undefined,
            actorId: target.actor_id ?? undefined,
            remoteAgentId: target.remote_agent_id ?? undefined,
            name: target.display_name ?? undefined,
          },
        ],
      } as never,
      queryable: client,
    })

    const recipients = await listConversationRealtimeRecipients(
      params.conversationId,
      client
    )
    // Remaining active members get a conversation.upsert (roster now reflects
    // the removal). The removed member is intentionally NOT in this list — a
    // conversation.upsert would (a) be skipped by syncConversationUpsert because
    // loadConversationView now excludes them via the active filter, and (b)
    // wrongly imply the conversation is still theirs. They get an explicit
    // membership.updated below instead.
    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      recipients.map((r) => r.workspaceMemberId),
      params.conversationId
    )

    // Tell the removed member (every one of their devices) they are out. This
    // is the authoritative "you were removed/left" signal — it does NOT depend
    // on loadConversationView (which now returns null for them), so it is
    // emitted directly. Self-leave still notifies the leaver so their OTHER
    // devices drop the conversation. participants snapshot reflects the
    // post-removal active roster.
    if (target.workspace_member_id) {
      const activeParticipants = await listConversationParticipants(
        params.conversationId,
        { queryable: client }
      )
      await appendWorkspaceMemberSyncEventInTransaction(client, {
        workspaceId: params.workspaceId,
        workspaceMemberId: target.workspace_member_id,
        conversationId: params.conversationId,
        eventType: "conversation.membership.updated",
        payload: {
          conversationId: params.conversationId,
          selfState: isSelfRemoval ? "left" : "removed",
          reason: isSelfRemoval ? "left" : "kicked",
          participants: activeParticipants
            .filter((p) => p.state === "active")
            .map(participantRowToChatParticipantSummary),
        },
      })
    }

    return {
      conversationId: params.conversationId,
      participantId: target.id,
      state: isSelfRemoval ? "left" : "removed",
    }
  })
}

export async function leaveChatConversation(params: {
  workspaceId: string
  userId: string
  conversationId: string
}) {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const access = await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )
  return removeChatConversationParticipant({
    workspaceId: params.workspaceId,
    userId: params.userId,
    conversationId: params.conversationId,
    participantId: access.participant.id,
  })
}

// ============ Stage 7: push tokens + typing ============

export interface ChatPushTokenRow {
  id: string
  workspaceMemberId: string
  platform: "ios" | "android" | "web"
  token: string
  deviceLabel: string | null
  createdAt: Timestamp
  lastSeenAt: Timestamp
}

function mapPushTokenRow(row: Record<string, unknown>): ChatPushTokenRow {
  return {
    id: String(row.id),
    workspaceMemberId: String(row.workspace_member_id),
    platform: row.platform as "ios" | "android" | "web",
    token: String(row.token),
    deviceLabel: (row.device_label as string | null) ?? null,
    createdAt: serializeInstant(row.created_at as Date),
    lastSeenAt: serializeInstant(row.last_seen_at as Date),
  }
}

export async function registerChatPushToken(params: {
  workspaceId: string
  userId: string
  platform: "ios" | "android" | "web"
  token: string
  deviceLabel?: string
  metadata?: Record<string, unknown>
}): Promise<{ token: ChatPushTokenRow }> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const result = await runOnDb<Record<string, unknown>>(
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
      identity.workspaceMemberId,
      params.platform,
      params.token,
      params.deviceLabel ?? null,
      JSON.stringify(params.metadata ?? {}),
    ]
  )
  const row = result.rows[0]
  if (!row) throw new Error("Failed to register push token")
  return { token: mapPushTokenRow(row) }
}

export async function listChatPushTokens(params: {
  workspaceId: string
  userId: string
}): Promise<{ tokens: ChatPushTokenRow[] }> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const result = await runOnDb<Record<string, unknown>>(
    `
      SELECT id, workspace_member_id, platform, token, device_label,
             created_at, last_seen_at
      FROM chat_push_tokens
      WHERE workspace_member_id = $1
      ORDER BY last_seen_at DESC
    `,
    [identity.workspaceMemberId]
  )
  return { tokens: result.rows.map(mapPushTokenRow) }
}

export async function deleteChatPushToken(params: {
  workspaceId: string
  userId: string
  tokenId: string
}): Promise<{ deleted: boolean }> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const result = await runOn<{ id: string }>(
    db,
    `
      DELETE FROM chat_push_tokens
      WHERE id = $1 AND workspace_member_id = $2
      RETURNING id
    `,
    [params.tokenId, identity.workspaceMemberId]
  )
  return { deleted: result.rows.length > 0 }
}

export async function broadcastTypingState(params: {
  workspaceId: string
  userId: string
  conversationId: string
  state: "started" | "stopped"
}): Promise<{ broadcast: boolean }> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )
  // Fan out via the event bus. Subscribers (WS bridge) will publish to other
  // participants. Typing is intentionally ephemeral — no DB persistence.
  const { emitEvent } = await import("../../infrastructure/events/index.js")
  await emitEvent({
    type: "chat.typing",
    workspaceId: params.workspaceId,
    payload: {
      conversationId: params.conversationId,
      fromWorkspaceMemberId: identity.workspaceMemberId,
      state: params.state,
      occurredAt: serializeNowInstant(),
    },
    timestamp: serializeNowInstant(),
  })
  return { broadcast: true }
}

// ============ Stage 16: assistant message retry ============

/**
 * Re-trigger an actor turn after a model_error_notice item. Looks up the
 * conversation item by id, verifies it's a retry-able error notice owned
 * by an accessible conversation, then enqueues a session wakeup that will
 * run another turn. UI calls this when the user taps "retry" on a failed
 * assistant message.
 */
export async function retryAssistantMessage(params: {
  workspaceId: string
  userId: string
  conversationId: string
  itemId: string
}): Promise<{
  retryEnqueued: boolean
  sessionId: string
  actorId: string
}> {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const access = await requireConversationAccess(
    rootQueryable(),
    params.conversationId,
    identity.workspaceMemberId
  )

  const item = await getConversationFeedItemById(params.itemId)
  if (!item || item.conversationId !== params.conversationId) {
    throw createChatError(404, "item_not_found", "Conversation item not found")
  }
  if (item.kind !== "message" || item.messageType !== "model_error_notice") {
    throw createChatError(
      400,
      "item_not_retryable",
      "Only model error notices can be retried"
    )
  }

  const metadata = (item.metadata ?? {}) as Record<string, unknown>
  const retrySessionId =
    typeof metadata.retrySessionId === "string" ? metadata.retrySessionId : null
  if (!retrySessionId) {
    throw createChatError(
      400,
      "retry_metadata_missing",
      "model_error_notice is missing retrySessionId in metadata"
    )
  }

  const actorId =
    typeof item.author?.actorId === "string" ? item.author.actorId : null
  if (!actorId) {
    throw createChatError(
      400,
      "retry_actor_missing",
      "model_error_notice has no actor author"
    )
  }

  // S19: the wakeup "source" is the caller (the user clicking retry),
  // NOT the original assistant author. The downstream model-error notice
  // path in session-thinking.ts:922 expects sourceParticipantType="workspace_member"
  // to come with sourceParticipantId = workspace_members.id (NOT a
  // conversation_participants.id) so it can re-query the participant
  // via getConversationParticipant({workspaceMemberId}).
  const { enqueueSessionWakeup } = await import("../session/runtime.js")
  await enqueueSessionWakeup({
    sessionId: retrySessionId,
    actorId,
    workspaceId: params.workspaceId,
    sourceType: "user_message",
    sourceItemId: params.itemId,
    sourceParticipantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    sourceParticipantId: identity.workspaceMemberId,
    sourceName: access.participant.user_name ?? "user",
    summary: "user requested retry of failed assistant turn",
    metadata: {
      source: "chat.message_retry",
      retryItemId: params.itemId,
      conversationId: params.conversationId,
      retryByParticipantId: access.participant.id,
    },
    trigger: "user_message",
  })

  return {
    retryEnqueued: true,
    sessionId: retrySessionId,
    actorId,
  }
}
