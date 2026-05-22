import { randomUUID } from "crypto"
import {
  buildConversationMessageRef,
  CONVERSATION_BOUNDARY,
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
  type ConversationBoundary,
  type ConversationMessageSubtype,
  type ConversationParticipantType,
  type ConversationReplyRef,
} from "@synapse/shared"
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
  InteractionRequestSummary,
} from "@synapse/shared/types"
import { transaction } from "../../infrastructure/database/index.js"
import {
  executeSql,
  executeSqlOn,
} from "../../infrastructure/database/kysely.js"
import {
  enqueueTransactionalEvent,
  type Queryable,
} from "../../infrastructure/events/index.js"
import { getFileUrlById } from "../files/service.js"
import {
  buildNormalizedMessageContent,
  canonicalContentBlocksToDraftParts,
  itemPartsToCanonicalContentBlocks,
} from "./message-content.js"
import {
  getConversationEventSpec,
  isConversationEventType,
  renderConversationEventTimelineBlocks,
} from "./event-registry.js"
import {
  requireWorkspaceMemberIdentity,
  type WorkspaceMemberIdentity,
} from "./workspace-identity.js"
import { enrichInteractionForUser } from "../interactions/service.js"
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
  fileId?: string
  json?: unknown
  mimeType?: string
  name?: string
  metadata?: Record<string, unknown>
}

type ConversationBaseRow = {
  conversation_id: string
  kind: ConversationKind
  boundary: ConversationBoundary
  title: string | null
  created_at: string | Date
  updated_at: string | Date
  unread_count: number | string
  muted: boolean
  archived: boolean
  pinned_sort_key: string | Date | null
  last_visible_item_id: string | null
  last_visible_sequence: number | string
  last_visible_at: string | Date | null
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
  joined_at: string | Date
  left_at: string | Date | null
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
  created_at: string | Date
}

type ItemPartRow = {
  item_id: string
  ordinal: number
  part_type: "text" | "file_ref" | "json"
  text_value: string | null
  file_id: string | null
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
  createdAt: string
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
  createdAt: string
}

type ConversationCreateExternalParticipantInput = {
  displayName: string
  metadata?: Record<string, unknown>
  transportAddressIds?: string[]
}

type ConversationCreateInput = {
  workspaceId: string
  creator: WorkspaceMemberIdentity
  clientRequestId: string
  kind: ConversationKind
  boundary: ConversationBoundary
  title?: string
  workspaceMemberIds: string[]
  actorIds: string[]
  externalParticipants: ConversationCreateExternalParticipantInput[]
  metadata?: Record<string, unknown>
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

function toIso(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString()
    }
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  return new Date().toISOString()
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
  if (item.itemType !== "event" || item.subtype !== "interaction_requested") {
    return item
  }

  const payload = item.eventPayload
  const interaction =
    payload && typeof payload === "object" && "interaction" in payload
      ? (payload as ConversationFeedEventPayloadMap["interaction_requested"])
          .interaction
      : undefined

  if (!interaction) {
    return item
  }

  return {
    ...item,
    eventPayload: {
      ...payload,
      interaction: await enrichInteractionForUser(
        interaction as InteractionRequestSummary,
        userId
      ),
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

  if (eventType === "interaction.updated") {
    const eventPayload =
      payload as ChatSyncEventPayloadMap["interaction.updated"]
    return {
      ...eventPayload,
      interaction: await enrichInteractionForUser(
        eventPayload.interaction,
        userId
      ),
    } as ChatSyncEventPayloadMap[T]
  }

  return payload
}

function asParticipantTransportKind(
  value: string | null | undefined
): ConversationEntityRef["transportKind"] {
  return value === "feishu" || value === "weixin" ? value : undefined
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
    (row.participant_type === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL ||
      row.participant_type === CONVERSATION_PARTICIPANT_TYPE.SYSTEM) &&
    typeof row.transport_display_name === "string" &&
    row.transport_display_name.trim()
  ) {
    return row.transport_display_name.trim()
  }
  if (
    (row.participant_type === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL ||
      row.participant_type === CONVERSATION_PARTICIPANT_TYPE.SYSTEM) &&
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
  return row.participant_type === CONVERSATION_PARTICIPANT_TYPE.SYSTEM
    ? "System"
    : "Unknown"
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
    params.kind === CONVERSATION_KIND.PRIVATE
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
    return params.kind === CONVERSATION_KIND.PRIVATE
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
  boundary: ConversationBoundary
  participants: ChatParticipantSummary[]
  viewerWorkspaceMemberId: string
}) {
  const activeParticipants = params.participants.filter(
    (participant) => participant.state === "active"
  )
  const peer =
    params.kind === CONVERSATION_KIND.PRIVATE
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
    params.kind === CONVERSATION_KIND.PRIVATE
      ? peer
        ? [peer]
        : activeParticipants.slice(0, 1)
      : activeParticipants.slice(0, 4)
  const boundaryLabel =
    params.boundary === CONVERSATION_BOUNDARY.EXTERNAL ? "External" : "Internal"

  return {
    chatType:
      params.kind === CONVERSATION_KIND.PRIVATE
        ? "direct"
        : params.kind === CONVERSATION_KIND.GROUP
          ? "group"
          : "virtual",
    subtitle:
      params.kind === CONVERSATION_KIND.PRIVATE
        ? `${boundaryLabel} direct chat`
        : params.kind === CONVERSATION_KIND.VIRTUAL
          ? `${boundaryLabel} virtual chat`
          : `${boundaryLabel} group chat`,
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

function rootQueryable(): Queryable {
  return {
    query: async (text: string, parameters?: any[]) =>
      executeSql(text, parameters).then((result) => ({
        rows: result.rows,
        rowCount: result.rowCount,
      })),
  }
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
  queryable: Queryable,
  input: UpdateClientInstanceInput
) {
  const existing = await executeSqlOn<{
    workspace_id: string
    workspace_member_id: string
  }>(
    queryable,
    `
      SELECT workspace_id, workspace_member_id
      FROM chat_client_instances
      WHERE id = $1
      LIMIT 1
    `,
    [input.clientInstanceId]
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
  queryable: Queryable,
  input: RegisterClientInstanceInput
) {
  const clientInstanceId = randomUUID()
  await executeSqlOn(
    queryable,
    `
      INSERT INTO chat_client_instances (
        id,
        workspace_id,
        workspace_member_id,
        platform,
        device_label,
        status,
        metadata,
        last_seen_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb, NOW(), NOW(), NOW())
    `,
    [
      clientInstanceId,
      input.workspaceId,
      input.workspaceMemberId,
      input.platform ?? null,
      input.deviceLabel ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  )

  return clientInstanceId
}

async function touchClientInstance(
  queryable: Queryable,
  input: UpdateClientInstanceInput
) {
  await ensureClientInstance(queryable, input)

  await executeSqlOn(
    queryable,
    `
      UPDATE chat_client_instances
      SET platform = COALESCE($2, platform),
          device_label = COALESCE($3, device_label),
          metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
          status = 'active',
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [
      input.clientInstanceId,
      input.platform ?? null,
      input.deviceLabel ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  )
}

async function listConversationParticipantRows(
  queryable: Queryable,
  conversationIds: string[],
  options?: { useProfileSnapshot?: boolean }
) {
  if (conversationIds.length === 0) {
    return [] as ParticipantRow[]
  }

  const actorNameExpr = options?.useProfileSnapshot
    ? "COALESCE(ra.name, joined_version.name, a.name)"
    : "COALESCE(ra.name, a.name)"
  const actorTitleExpr = options?.useProfileSnapshot
    ? "COALESCE(ra.title, joined_version.title, a.title)"
    : "COALESCE(ra.title, a.title)"
  const actorRoleExpr = options?.useProfileSnapshot
    ? "COALESCE(CASE WHEN ra.id IS NOT NULL THEN 'remote_agent' END, joined_version.role::text, a.role::text)"
    : "COALESCE(CASE WHEN ra.id IS NOT NULL THEN 'remote_agent' END, a.role::text)"
  const actorCanRepresentExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.can_represent_user, a.can_represent_user)"
    : "a.can_represent_user"
  const actorSpecialtiesExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.specialties, a.specialties)"
    : "a.specialties"
  const actorConfigExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.config, a.config)"
    : "a.config"
  const actorCurrentVersionExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.version, a.current_version)"
    : "a.current_version"
  const actorDocVersionExpr = options?.useProfileSnapshot
    ? "COALESCE(cp.actor_join_version_id, current_version.id)"
    : "current_version.id"

  const result = await executeSqlOn<ParticipantRow>(
    queryable,
    `
      SELECT
        cp.id,
        cp.conversation_id,
        cp.participant_type,
        cp.workspace_member_id,
        cp.actor_id,
        cp.remote_agent_id,
        cp.actor_join_version_id,
        cp.display_name,
        cp.role_key,
        cp.state,
        cp.metadata,
        cp.joined_at,
        cp.left_at,
        wm.user_id,
        u.name AS user_name,
        ${actorNameExpr} AS participant_name,
        ${actorTitleExpr} AS participant_title,
        ${actorRoleExpr} AS participant_role,
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
              WHERE avd.actor_version_id = ${actorDocVersionExpr}
            ),
            '[]'::jsonb
          )
        END AS actor_docs,
        ${actorCanRepresentExpr} AS actor_can_represent_user,
        ${actorSpecialtiesExpr} AS actor_specialties,
        ${actorConfigExpr} AS actor_config,
        ${actorCurrentVersionExpr} AS actor_current_version,
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
      LEFT JOIN workspace_members wm ON wm.id = cp.workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      LEFT JOIN actors a ON a.id = cp.actor_id
      LEFT JOIN remote_agents ra ON ra.id = cp.remote_agent_id
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
        ON rab.remote_agent_id = cp.remote_agent_id
      LEFT JOIN LATERAL (
        SELECT s.id, s.status
        FROM sessions s
        WHERE s.conversation_id = cp.conversation_id
          AND s.actor_id = cp.actor_id
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
  queryable: Queryable,
  conversationId: string,
  workspaceMemberId: string
) {
  const result = await executeSqlOn<ParticipantRow>(
    queryable,
    `
      SELECT
        cp.id,
        cp.conversation_id,
        cp.participant_type,
        cp.workspace_member_id,
        cp.actor_id,
        cp.remote_agent_id,
        cp.actor_join_version_id,
        cp.display_name,
        cp.role_key,
        cp.state,
        cp.metadata,
        cp.joined_at,
        cp.left_at,
        wm.user_id,
        u.name AS user_name,
        COALESCE(ra.name, a.name) AS participant_name,
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
      LEFT JOIN workspace_members wm ON wm.id = cp.workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      LEFT JOIN actors a ON a.id = cp.actor_id
      LEFT JOIN remote_agents ra ON ra.id = cp.remote_agent_id
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
        ON rab.remote_agent_id = cp.remote_agent_id
      LEFT JOIN LATERAL (
        SELECT s.id, s.status
        FROM sessions s
        WHERE s.conversation_id = cp.conversation_id
          AND s.actor_id = cp.actor_id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) ls ON TRUE
      WHERE cp.conversation_id = $1
        AND cp.workspace_member_id = $2
      LIMIT 1
    `,
    [conversationId, workspaceMemberId]
  )

  return result.rows[0] ?? null
}

async function getConversationBaseRow(
  queryable: Queryable,
  workspaceMemberId: string,
  conversationId: string
) {
  const result = await executeSqlOn<ConversationBaseRow>(
    queryable,
    `
      SELECT
        c.id AS conversation_id,
        c.kind,
        c.boundary,
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
      LIMIT 1
    `,
    [workspaceMemberId, conversationId]
  )

  return result.rows[0] ?? null
}

async function listConversationBaseRows(
  queryable: Queryable,
  workspaceMemberId: string
) {
  const result = await executeSqlOn<ConversationBaseRow>(
    queryable,
    `
      SELECT
        c.id AS conversation_id,
        c.kind,
        c.boundary,
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

async function listItemRowsByIds(queryable: Queryable, itemIds: string[]) {
  if (itemIds.length === 0) {
    return [] as ItemRow[]
  }

  const result = await executeSqlOn<ItemRow>(
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
  queryable: Queryable,
  itemRows: ItemRow[]
) {
  if (itemRows.length === 0) {
    return [] as HydratedConversationItemRecord[]
  }

  const itemIds = itemRows.map((row) => row.id)
  const [partsResult, restrictedAudienceResult] = await Promise.all([
    executeSqlOn<ItemPartRow>(
      queryable,
      `
        SELECT
          item_id,
          ordinal,
          part_type,
          text_value,
          file_id,
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
    executeSqlOn<ParticipantLinkRow>(
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
      createdAt: toIso(row.created_at),
    })
  }

  return itemRows.map((row) => itemMap.get(row.id)!).filter(Boolean)
}

async function loadConversationViews(
  queryable: Queryable,
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
      row.kind !== "private" &&
      (viewerConversationRole === "owner" || viewerConversationRole === "admin")
    const canRename = row.kind !== "private" && canManageConversation
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
      boundary: row.boundary,
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
      boundary: row.boundary,
      status,
      unreadCount: toNumber(row.unread_count),
      muted: Boolean(row.muted),
      archived: Boolean(row.archived),
      pinnedSortKey: row.pinned_sort_key
        ? toIso(row.pinned_sort_key)
        : undefined,
      updatedAt: toIso(row.updated_at),
      createdAt: toIso(row.created_at),
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
  queryable: Queryable,
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
  queryable: Queryable,
  workspaceId: string,
  workspaceMemberId: string
) {
  const result = await executeSqlOn<{ cursor: string | number }>(
    queryable,
    `
      SELECT COALESCE(MAX(sync_seq), 0) AS cursor
      FROM workspace_member_sync_events
      WHERE workspace_id = $1
        AND workspace_member_id = $2
    `,
    [workspaceId, workspaceMemberId]
  )
  return toNumber(result.rows[0]?.cursor)
}

async function countUnreadVisibleMessages(
  queryable: Queryable,
  conversationId: string,
  participantId: string
) {
  const result = await executeSqlOn<{ unread_count: string | number }>(
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
  queryable: Queryable
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
  queryable: Queryable,
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
  await executeSqlOn(
    queryable,
    `
      INSERT INTO workspace_member_conversation_views (
        workspace_member_id,
        conversation_id,
        last_visible_item_id,
        last_visible_sequence,
        last_visible_at,
        unread_count,
        summary,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
      ON CONFLICT (workspace_member_id, conversation_id) DO UPDATE
      SET last_visible_item_id = COALESCE(EXCLUDED.last_visible_item_id, workspace_member_conversation_views.last_visible_item_id),
          last_visible_sequence = GREATEST(workspace_member_conversation_views.last_visible_sequence, EXCLUDED.last_visible_sequence),
          last_visible_at = COALESCE(EXCLUDED.last_visible_at, workspace_member_conversation_views.last_visible_at),
          unread_count = EXCLUDED.unread_count,
          summary = COALESCE(workspace_member_conversation_views.summary, '{}'::jsonb) || EXCLUDED.summary,
          updated_at = NOW()
    `,
    [
      params.workspaceMemberId,
      params.conversationId,
      params.lastVisibleItemId ?? null,
      params.lastVisibleSequence ?? 0,
      params.lastVisibleAt ?? null,
      params.unreadCount,
      JSON.stringify(params.summary ?? {}),
    ]
  )
}

export async function appendWorkspaceMemberSyncEvent<
  T extends ChatSyncEventType,
>(
  queryable: Queryable,
  params: {
    workspaceId: string
    workspaceMemberId: string
    conversationId?: string
    itemId?: string
    eventType: T
    payload: ChatSyncEventPayloadMap[T]
  }
) {
  const inserted = await executeSqlOn<{
    sync_seq: string | number
    occurred_at: string | Date
  }>(
    queryable,
    `
      INSERT INTO workspace_member_sync_events (
        workspace_id,
        workspace_member_id,
        conversation_id,
        item_id,
        event_type,
        payload,
        occurred_at,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())
      RETURNING sync_seq, occurred_at
    `,
    [
      params.workspaceId,
      params.workspaceMemberId,
      params.conversationId ?? null,
      params.itemId ?? null,
      params.eventType,
      JSON.stringify(params.payload),
    ]
  )

  const row = inserted.rows[0]
  const envelope: ChatSyncEvent<T> = {
    syncSeq: toNumber(row?.sync_seq),
    workspaceId: params.workspaceId,
    workspaceMemberId: params.workspaceMemberId,
    conversationId: params.conversationId,
    itemId: params.itemId,
    eventType: params.eventType,
    payload: params.payload,
    occurredAt: toIso(row?.occurred_at),
  }

  await enqueueTransactionalEvent(queryable, {
    type: "chat.sync.event",
    workspaceId: params.workspaceId,
    recipientWorkspaceMemberId: params.workspaceMemberId,
    payload: envelope as unknown as Record<string, unknown>,
    timestamp: envelope.occurredAt,
  })

  return envelope
}

async function getConversationSequenceMax(
  queryable: Queryable,
  conversationId: string
) {
  const result = await executeSqlOn<{ max_sequence: string | number | null }>(
    queryable,
    `
      SELECT MAX(sequence) AS max_sequence
      FROM conversation_items
      WHERE conversation_id = $1
    `,
    [conversationId]
  )

  return toNumber(result.rows[0]?.max_sequence)
}

async function getLastItemAtOrBeforeSequence(
  queryable: Queryable,
  conversationId: string,
  sequence: number
) {
  const result = await executeSqlOn<{ id: string }>(
    queryable,
    `
      SELECT id
      FROM conversation_items
      WHERE conversation_id = $1
        AND sequence <= $2
      ORDER BY sequence DESC
      LIMIT 1
    `,
    [conversationId, sequence]
  )
  return result.rows[0]?.id ?? null
}

async function requireConversationAccess(
  queryable: Queryable,
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
  queryable: Queryable,
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
  queryable: Queryable,
  conversationId: string,
  replyToItemId?: string,
  authorParticipantId?: string
) {
  if (!replyToItemId) {
    return null
  }
  const rows = await executeSqlOn<ItemRow>(
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
  queryable?: Queryable
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
    ? await executeSqlOn<Pick<ItemRow, "id" | "sequence">>(
        params.queryable,
        exactSql,
        [params.conversationId, sequence, params.participantId ?? null]
      )
    : await executeSql<Pick<ItemRow, "id" | "sequence">>(exactSql, [
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
    ? await executeSqlOn<Pick<ItemRow, "id" | "sequence">>(
        params.queryable,
        nearbySql,
        [params.conversationId, sequence, params.participantId ?? null]
      )
    : await executeSql<Pick<ItemRow, "id" | "sequence">>(nearbySql, [
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
  queryable: Queryable,
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
  queryable: Queryable,
  itemId: string
) {
  const result = await executeSqlOn<{ mentioned_participant_id: string }>(
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
  sourceParticipantType?: ParticipantKind
  sourceParticipantId?: string
  sourceName?: string
  summary?: string
  queryable?: Queryable
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

  const restrictedAudienceResult = await executeSqlOn<ParticipantLinkRow>(
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

  const conversationRow = await executeSqlOn<{ kind: ConversationKind }>(
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
  if (
    !sourceParticipantType ||
    sourceParticipantType === CONVERSATION_PARTICIPANT_TYPE.SYSTEM
  ) {
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
        channelType: "web",
        trigger: sourceType,
        metadata: {
          source: "chat.message_wakeup",
        },
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
  queryable: Queryable,
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
  queryable: Queryable,
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

async function insertParticipant(
  queryable: Queryable,
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
    transportAddressIds?: string[]
  }
) {
  const participantId = crypto.randomUUID()
  await executeSqlOn(
    queryable,
    `
      INSERT INTO conversation_participants (
        id,
        conversation_id,
        participant_type,
        workspace_member_id,
        actor_id,
        remote_agent_id,
        actor_join_version_id,
        display_name,
        role_key,
        state,
        metadata,
        joined_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10::jsonb, NOW())
    `,
    [
      participantId,
      params.conversationId,
      params.participantType,
      params.workspaceMemberId ?? null,
      params.actorId ?? null,
      params.remoteAgentId ?? null,
      params.actorJoinVersionId ?? null,
      params.displayName ?? null,
      params.roleKey,
      JSON.stringify(params.metadata ?? {}),
    ]
  )

  await executeSqlOn(
    queryable,
    `
      INSERT INTO conversation_participant_states (
        conversation_id,
        participant_id,
        read_watermark_sequence,
        created_at,
        updated_at
      )
      VALUES ($1, $2, 0, NOW(), NOW())
      ON CONFLICT (conversation_id, participant_id) DO NOTHING
    `,
    [params.conversationId, participantId]
  )

  if (
    Array.isArray(params.transportAddressIds) &&
    params.transportAddressIds.length > 0
  ) {
    for (const [
      index,
      transportAddressId,
    ] of params.transportAddressIds.entries()) {
      await executeSqlOn(
        queryable,
        `
          INSERT INTO conversation_participant_addresses (
            conversation_participant_id,
            transport_address_id,
            is_primary,
            metadata,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, '{}'::jsonb, NOW(), NOW())
          ON CONFLICT (conversation_participant_id, transport_address_id) DO NOTHING
        `,
        [participantId, transportAddressId, index === 0]
      )
    }
  }

  return {
    id: participantId,
  }
}

async function loadWorkspaceMembersByIds(
  queryable: Queryable,
  workspaceId: string,
  workspaceMemberIds: string[]
) {
  if (workspaceMemberIds.length === 0) {
    return [] as Array<{ id: string; user_name: string }>
  }
  const result = await executeSqlOn<{ id: string; user_name: string }>(
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
  queryable: Queryable,
  workspaceId: string,
  actorIds: string[]
) {
  if (actorIds.length === 0) {
    return [] as Array<{ id: string; name: string }>
  }
  const result = await executeSqlOn<{ id: string; name: string }>(
    queryable,
    `
      SELECT id, name
      FROM actors
      WHERE workspace_id = $1
        AND id = ANY($2::uuid[])
    `,
    [workspaceId, actorIds]
  )
  return result.rows
}

async function loadRemoteAgentsByIds(
  queryable: Queryable,
  remoteAgentIds: string[]
) {
  if (remoteAgentIds.length === 0) {
    return [] as Array<{ id: string; name: string }>
  }
  const result = await executeSqlOn<{ id: string; name: string }>(
    queryable,
    `
      SELECT id, name
      FROM remote_agents
      WHERE is_active = TRUE
        AND id = ANY($1::uuid[])
    `,
    [remoteAgentIds]
  )
  return result.rows
}

async function validateTransportAddresses(
  queryable: Queryable,
  workspaceId: string,
  addressIds: string[]
) {
  if (addressIds.length === 0) {
    return
  }
  const result = await executeSqlOn<{ id: string }>(
    queryable,
    `
      SELECT id
      FROM transport_addresses
      WHERE workspace_id = $1
        AND id = ANY($2::uuid[])
    `,
    [workspaceId, addressIds]
  )
  if (result.rows.length !== addressIds.length) {
    throw createChatError(
      400,
      "invalid_transport_address",
      "One or more transport addresses are invalid"
    )
  }
}

export async function getConversation(
  conversationId: string,
  queryable: Queryable = rootQueryable()
) {
  const result = await executeSqlOn<Record<string, unknown>>(
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
  boundary?: ConversationBoundary
  workspaceId?: string
  title?: string
  createdByWorkspaceMemberId?: string
  metadata?: Record<string, unknown>
  queryable?: Queryable
}) {
  const queryable = params.queryable ?? rootQueryable()
  const id = crypto.randomUUID()
  const result = await executeSqlOn<Record<string, unknown>>(
    queryable,
    `
      INSERT INTO conversations (
        id,
        kind,
        boundary,
        internal_workspace_id,
        title,
        created_by_workspace_member_id,
        metadata,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
      RETURNING *
    `,
    [
      id,
      params.kind,
      params.boundary ?? "internal",
      params.boundary === CONVERSATION_BOUNDARY.EXTERNAL
        ? null
        : (params.workspaceId ?? null),
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
  boundary?: ConversationBoundary
  title?: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  externalParticipants?: ConversationCreateExternalParticipantInput[]
  metadata?: Record<string, unknown>
  queryable?: Queryable
}) {
  const executeCreate = async (queryable: Queryable) => {
    const conversation = await createConversation({
      kind: params.kind,
      boundary: params.boundary ?? "internal",
      workspaceId: params.workspaceId,
      title: params.title,
      createdByWorkspaceMemberId: params.creatorWorkspaceMemberId,
      metadata: params.metadata,
      queryable,
    })

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
    const externalParticipants = params.externalParticipants ?? []

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
          conversationId: conversation.id as string,
          participantType: "actor",
          actorId: actor.id,
          displayName: actor.name,
          queryable,
        })
      }
    }

    if (remoteAgentIds.length > 0) {
      const remoteAgentRows = await loadRemoteAgentsByIds(
        queryable,
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
          conversationId: conversation.id as string,
          participantType: "remote_agent",
          remoteAgentId: remoteAgent.id,
          displayName: remoteAgent.name,
          queryable,
        })
      }
    }

    for (const externalParticipant of externalParticipants) {
      await ensureConversationParticipant({
        conversationId: conversation.id as string,
        participantType: "external",
        displayName: externalParticipant.displayName,
        metadata: externalParticipant.metadata,
        transportAddressIds: externalParticipant.transportAddressIds,
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
  return transaction((client) => executeCreate(client))
}

export async function listConversationParticipants(
  conversationId: string,
  options?: { useProfileSnapshot?: boolean; queryable?: Queryable }
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
  queryable?: Queryable
}) {
  if (params.participantId) {
    const result = await executeSqlOn<ParticipantRow>(
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
  transportAddressIds?: string[]
  queryable?: Queryable
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

  const existing = await executeSqlOn<{ id: string; state: string }>(
    queryable,
    `
      SELECT id, state
      FROM conversation_participants
      WHERE conversation_id = $1
        AND participant_type = $2
        AND (
          ($2 = 'workspace_member' AND workspace_member_id = $3)
          OR ($2 = 'actor' AND actor_id = $4)
          OR ($2 = 'remote_agent' AND remote_agent_id = $5)
          OR (
            $2 IN ('external', 'system')
            AND COALESCE(display_name, '') = COALESCE($6, '')
          )
        )
      LIMIT 1
    `,
    [
      params.conversationId,
      params.participantType,
      params.workspaceMemberId ?? null,
      params.actorId ?? null,
      params.remoteAgentId ?? null,
      params.displayName ?? null,
    ]
  )

  const existingId = existing.rows[0]?.id
  if (existingId) {
    await executeSqlOn(
      queryable,
      `
        UPDATE conversation_participants
        SET workspace_member_id = COALESCE($2, workspace_member_id),
            actor_id = COALESCE($3, actor_id),
            remote_agent_id = COALESCE($4, remote_agent_id),
            actor_join_version_id = COALESCE($5, actor_join_version_id),
            display_name = COALESCE($6, display_name),
            role_key = COALESCE($7, role_key),
            state = 'active',
            left_at = NULL,
            metadata = COALESCE(conversation_participants.metadata, '{}'::jsonb) || $8::jsonb
        WHERE id = $1
      `,
      [
        existingId,
        params.workspaceMemberId ?? null,
        params.actorId ?? null,
        params.remoteAgentId ?? null,
        params.actorJoinVersionId ?? null,
        params.displayName ?? null,
        params.roleKey ?? "member",
        JSON.stringify(params.metadata ?? {}),
      ]
    )

    if (
      Array.isArray(params.transportAddressIds) &&
      params.transportAddressIds.length > 0
    ) {
      for (const [
        index,
        transportAddressId,
      ] of params.transportAddressIds.entries()) {
        await executeSqlOn(
          queryable,
          `
            INSERT INTO conversation_participant_addresses (
              conversation_participant_id,
              transport_address_id,
              is_primary,
              metadata,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, '{}'::jsonb, NOW(), NOW())
            ON CONFLICT (conversation_participant_id, transport_address_id) DO UPDATE
            SET is_primary = EXCLUDED.is_primary,
                updated_at = NOW()
          `,
          [existingId, transportAddressId, index === 0]
        )
      }
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
    transportAddressIds: params.transportAddressIds,
  })

  return getConversationParticipant({
    conversationId: params.conversationId,
    participantId: inserted.id,
    queryable,
  })
}

export async function addConversationParticipants(params: {
  workspaceId: string
  conversationId: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  externalParticipants?: ConversationCreateExternalParticipantInput[]
  queryable?: Queryable
}) {
  const executeAdd = async (queryable: Queryable) => {
    const workspaceMemberIds = [...new Set(params.workspaceMemberIds ?? [])]
    const actorIds = [...new Set(params.actorIds ?? [])]
    const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]
    const externalParticipants = params.externalParticipants ?? []

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
          displayName: actor.name,
          queryable,
        })
      }
    }

    if (remoteAgentIds.length > 0) {
      const remoteAgentRows = await loadRemoteAgentsByIds(
        queryable,
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
          displayName: remoteAgent.name,
          queryable,
        })
      }
    }

    for (const externalParticipant of externalParticipants) {
      await ensureConversationParticipant({
        conversationId: params.conversationId,
        participantType: "external",
        displayName: externalParticipant.displayName,
        metadata: externalParticipant.metadata,
        transportAddressIds: externalParticipant.transportAddressIds,
        queryable,
      })
    }

    if (workspaceMemberIds.length > 0) {
      await syncConversationUpsertForWorkspaceMembers(
        queryable,
        params.workspaceId,
        workspaceMemberIds,
        params.conversationId
      )
    }

    return listConversationParticipants(params.conversationId, { queryable })
  }

  if (params.queryable) {
    return executeAdd(params.queryable)
  }
  return transaction((client) => executeAdd(client))
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
  queryable?: Queryable
}) {
  const executeInsert = async (queryable: Queryable) => {
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

    const inserted = await executeSqlOn<ItemRow>(
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
      const existing = await executeSqlOn<ItemRow>(
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
      const duplicateItems = await buildChatConversationItems(queryable, [
        insertedItem,
      ])
      return duplicateItems[0]!
    }

    for (const [ordinal, part] of prepared.parts.entries()) {
      await executeSqlOn(
        queryable,
        `
          INSERT INTO conversation_item_parts (
            id,
            item_id,
            ordinal,
            part_type,
            text_value,
            file_id,
            json_value,
            mime_type,
            name,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)
        `,
        [
          crypto.randomUUID(),
          insertedItem.id,
          ordinal,
          part.type,
          part.type === "text" ? (part.text ?? "") : null,
          part.type === "file_ref" ? (part.fileId ?? null) : null,
          part.type === "json" ? JSON.stringify(part.json ?? {}) : null,
          part.mimeType ?? null,
          part.name ?? null,
          JSON.stringify(part.metadata ?? {}),
        ]
      )
    }

    if (prepared.mentionedParticipants.length > 0) {
      for (const mention of prepared.mentionedParticipants) {
        await executeSqlOn(
          queryable,
          `
            INSERT INTO conversation_item_mentions (
              item_id,
              ordinal,
              mentioned_participant_id
            )
            VALUES ($1, $2, $3)
          `,
          [insertedItem.id, mention.ordinal, mention.participantId]
        )
      }
    }

    for (const participantId of params.restrictedAudienceParticipantIds ?? []) {
      await executeSqlOn(
        queryable,
        `
          INSERT INTO conversation_item_targets (
            item_id,
            target_participant_id,
            target_kind
          )
          VALUES ($1, $2, 'to')
        `,
        [insertedItem.id, participantId]
      )
    }

    for (const participantId of params.contextTargetParticipantIds ?? []) {
      await executeSqlOn(
        queryable,
        `
          INSERT INTO conversation_item_context_targets (
            item_id,
            target_participant_id
          )
          VALUES ($1, $2)
        `,
        [insertedItem.id, participantId]
      )
    }

    await executeSqlOn(
      queryable,
      `
        UPDATE conversations
        SET updated_at = NOW()
        WHERE id = $1
      `,
      [params.conversationId]
    )

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
  return transaction((client) => executeInsert(client))
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
  queryable?: Queryable
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
  queryable?: Queryable
}) {
  const executeCreate = async (queryable: Queryable) => {
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
  return transaction((client) => executeCreate(client))
}

export async function updateConversationItemEventPayload<
  T extends ConversationFeedEventType,
>(
  itemId: string,
  payload: ConversationFeedEventPayloadMap[T],
  queryable: Queryable = rootQueryable()
) {
  await executeSqlOn(
    queryable,
    `
      UPDATE conversation_items
      SET event_payload = $2::jsonb
      WHERE id = $1
    `,
    [itemId, JSON.stringify(payload)]
  )
}

async function buildConversationItemDetails(
  queryable: Queryable,
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
  const contextTargetsResult = await executeSqlOn<ParticipantLinkRow>(
    queryable,
    `
      SELECT item_id, target_participant_id
      FROM conversation_item_context_targets
      WHERE item_id = ANY($1::uuid[])
      ORDER BY item_id ASC, target_participant_id ASC
    `,
    [itemIds]
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
      createdAt: toIso(replyRow.created_at),
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
      createdAt: toIso(row.created_at),
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
    participantType: participant.participant_type,
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
    participantType: participant.participant_type,
    workspaceMemberId: entity.workspaceMemberId,
    actorId: entity.actorId,
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
    joinedAt: toIso(participant.joined_at),
    leftAt: participant.left_at ? toIso(participant.left_at) : undefined,
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
    createdAt: item.createdAt,
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
  queryable: Queryable,
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
    createdAt: item.createdAt,
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
  const transportKind =
    value.transportKind === "feishu" || value.transportKind === "weixin"
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
  queryable: Queryable,
  itemIds: string[]
) {
  if (itemIds.length === 0) {
    return new Map<string, ConversationMessageTransportDelivery[]>()
  }
  const result = await executeSqlOn<{
    item_id: string
    link_id: string
    transport_kind: "feishu" | "weixin"
    direction: "inbound" | "outbound"
    delivery_status: "pending" | "sent" | "failed" | "skipped"
    external_message_id: string | null
    metadata: unknown
    delivered_at: string | Date | null
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
      deliveredAt: row.delivered_at ? toIso(row.delivered_at) : undefined,
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
    createdAt: item.createdAt,
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
  queryable: Queryable = rootQueryable()
) {
  const rows = await executeSqlOn<ItemRow>(
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
  queryable?: Queryable
}) {
  const queryable = params.queryable ?? rootQueryable()
  const result = await executeSqlOn<ItemRow>(
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
  queryable: Queryable = rootQueryable()
) {
  const result = await executeSqlOn<ItemRow>(
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
  queryable?: Queryable
}) {
  return loadConversationViews(
    params.queryable ?? rootQueryable(),
    params.workspaceId,
    params.workspaceMemberId
  )
}

export async function listConversationRealtimeRecipients(
  conversationId: string,
  queryable: Queryable = rootQueryable()
) {
  const result = await executeSqlOn<{
    workspace_id: string
    workspace_member_id: string
  }>(
    queryable,
    `
      SELECT wm.workspace_id, cp.workspace_member_id
      FROM conversation_participants cp
      INNER JOIN workspace_members wm
        ON wm.id = cp.workspace_member_id
      WHERE cp.conversation_id = $1
        AND cp.state = 'active'
        AND cp.workspace_member_id IS NOT NULL
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
  const clientInstanceId = await transaction(async (client) =>
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
  await transaction(async (client) => {
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
  boundary?: ConversationBoundary
  title?: string
  workspaceMemberIds?: string[]
  actorIds?: string[]
  remoteAgentIds?: string[]
  externalParticipants?: ConversationCreateExternalParticipantInput[]
  metadata?: Record<string, unknown>
}): Promise<ChatConversationCreateResponse> {
  const creator = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  const boundary = params.boundary ?? "internal"
  const workspaceMemberIds = [
    ...new Set([
      creator.workspaceMemberId,
      ...(params.workspaceMemberIds ?? []),
    ]),
  ]
  const actorIds = [...new Set(params.actorIds ?? [])]
  const remoteAgentIds = [...new Set(params.remoteAgentIds ?? [])]
  const externalParticipants = params.externalParticipants ?? []

  if (boundary === "internal" && externalParticipants.length > 0) {
    throw createChatError(
      400,
      "external_participants_not_allowed",
      "Internal conversations do not allow external participants"
    )
  }

  const conversationId = await transaction(async (client) => {
    const existingRequest = await executeSqlOn<{ conversation_id: string }>(
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

    const remoteAgentRows = await loadRemoteAgentsByIds(client, remoteAgentIds)
    if (remoteAgentRows.length !== remoteAgentIds.length) {
      throw createChatError(
        400,
        "invalid_remote_agent",
        "One or more remote agents are invalid"
      )
    }

    const addressIds = externalParticipants.flatMap(
      (participant) => participant.transportAddressIds ?? []
    )
    await validateTransportAddresses(client, params.workspaceId, [
      ...new Set(addressIds),
    ])

    const newConversationId = crypto.randomUUID()
    await executeSqlOn(
      client,
      `
        INSERT INTO conversations (
          id,
          kind,
          boundary,
          internal_workspace_id,
          title,
          created_by_workspace_member_id,
          metadata,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
      `,
      [
        newConversationId,
        params.kind,
        boundary,
        boundary === "internal" ? params.workspaceId : null,
        params.title?.trim() || null,
        creator.workspaceMemberId,
        JSON.stringify(params.metadata ?? {}),
      ]
    )

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
        displayName: actor.name,
        roleKey: "member",
        metadata: {},
      })
    }

    for (const remoteAgent of remoteAgentRows) {
      await insertParticipant(client, {
        conversationId: newConversationId,
        participantType: "remote_agent",
        remoteAgentId: remoteAgent.id,
        displayName: remoteAgent.name,
        roleKey: "member",
        metadata: {},
      })
    }

    for (const external of externalParticipants) {
      await insertParticipant(client, {
        conversationId: newConversationId,
        participantType: "external",
        displayName: external.displayName,
        roleKey: "member",
        metadata: external.metadata ?? {},
        transportAddressIds: external.transportAddressIds,
      })
    }

    await executeSqlOn(
      client,
      `
        INSERT INTO chat_conversation_create_requests (
          workspace_member_id,
          client_request_id,
          workspace_id,
          conversation_id,
          created_at
        )
        VALUES ($1, $2, $3, $4, NOW())
      `,
      [
        creator.workspaceMemberId,
        params.clientRequestId,
        params.workspaceId,
        newConversationId,
      ]
    )

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
  const conversations = await loadConversationViews(
    rootQueryable(),
    params.workspaceId,
    identity.workspaceMemberId
  )
  const nextInboxCursor = await getCurrentSyncCursor(
    rootQueryable(),
    params.workspaceId,
    identity.workspaceMemberId
  )

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
  const result = await executeSql<{
    sync_seq: string | number
    workspace_id: string
    workspace_member_id: string
    conversation_id: string | null
    item_id: string | null
    event_type: ChatSyncEventType
    payload: unknown
    occurred_at: string | Date
  }>(
    `
      SELECT
        sync_seq,
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
        AND sync_seq > $3
      ORDER BY sync_seq ASC
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
        workspaceId: row.workspace_id,
        workspaceMemberId: row.workspace_member_id,
        conversationId: row.conversation_id ?? undefined,
        itemId: row.item_id ?? undefined,
        eventType,
        payload: enrichedPayload,
        occurredAt: toIso(row.occurred_at),
      }
    })
  )

  return {
    events,
    nextCursor:
      events.length > 0
        ? events[events.length - 1]!.syncSeq
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
    const result = await executeSql<ItemRow>(
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
    const result = await executeSql<ItemRow>(
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
    const result = await executeSql<ItemRow>(
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

  const readState = await executeSql<{
    read_watermark_sequence: string | number
  }>(
    `
      SELECT read_watermark_sequence
      FROM conversation_participant_states
      WHERE conversation_id = $1
        AND participant_id = $2
      LIMIT 1
    `,
    [params.conversationId, access.participant.id]
  )

  const deviceStateResult = await executeSql<{
    client_instance_id: string
    conversation_id: string
    last_visible_sequence: string | number
    last_inbox_seq: string | number
    last_opened_at: string | Date | null
    draft_payload: unknown
  }>(
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
        lastOpenedAt: row.last_opened_at
          ? toIso(row.last_opened_at)
          : undefined,
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
      const snapshot = await loadRemoteAgentRuntimeSnapshot(remoteAgentId)
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
  queryable: Queryable,
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
  queryable?: Queryable
}) {
  const queryable = params.queryable ?? rootQueryable()
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200)
  let rows: ItemRow[] = []

  if (typeof params.afterSequence === "number") {
    const result = await executeSqlOn<ItemRow>(
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
    const result = await executeSqlOn<ItemRow>(
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
    const result = await executeSqlOn<ItemRow>(
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

  const item = await transaction(async (client) => {
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
  return transaction(async (client) => {
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

    const existingState = await executeSqlOn<{
      read_watermark_sequence: string | number
    }>(
      client,
      `
        SELECT read_watermark_sequence
        FROM conversation_participant_states
        WHERE conversation_id = $1
          AND participant_id = $2
        LIMIT 1
      `,
      [params.conversationId, access.participant.id]
    )
    const nextSequence = Math.max(
      toNumber(existingState.rows[0]?.read_watermark_sequence),
      requestedSequence
    )
    const lastReadItemId = await getLastItemAtOrBeforeSequence(
      client,
      params.conversationId,
      nextSequence
    )

    await executeSqlOn(
      client,
      `
        INSERT INTO conversation_participant_states (
          conversation_id,
          participant_id,
          read_watermark_sequence,
          last_read_item_id,
          last_read_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
        ON CONFLICT (conversation_id, participant_id) DO UPDATE
        SET read_watermark_sequence = GREATEST(conversation_participant_states.read_watermark_sequence, EXCLUDED.read_watermark_sequence),
            last_read_item_id = EXCLUDED.last_read_item_id,
            last_read_at = NOW(),
            updated_at = NOW()
      `,
      [
        params.conversationId,
        access.participant.id,
        nextSequence,
        lastReadItemId,
      ]
    )

    if (params.clientInstanceId) {
      const lastVisibleSequence = Math.min(
        maxSequence,
        Math.max(params.lastVisibleSequence ?? nextSequence, nextSequence)
      )
      await executeSqlOn(
        client,
        `
          INSERT INTO conversation_device_states (
            conversation_id,
            client_instance_id,
            last_visible_sequence,
            last_opened_at,
            last_inbox_seq,
            draft_payload,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, NOW(), 0, '{}'::jsonb, NOW(), NOW())
          ON CONFLICT (conversation_id, client_instance_id) DO UPDATE
          SET last_visible_sequence = GREATEST(conversation_device_states.last_visible_sequence, EXCLUDED.last_visible_sequence),
              last_opened_at = NOW(),
              updated_at = NOW()
        `,
        [params.conversationId, params.clientInstanceId, lastVisibleSequence]
      )
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

    const lastReadAt = new Date().toISOString()
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
  return transaction(async (client) => {
    await requireConversationAccess(
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
    setFragments.push("updated_at = NOW()")
    values.push(params.conversationId)

    await executeSqlOn(
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
  externalParticipants?: ConversationCreateExternalParticipantInput[]
}) {
  const identity = await getWorkspaceMemberIdentityOrThrow(
    params.workspaceId,
    params.userId
  )
  return transaction(async (client) => {
    await requireConversationAccess(
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
      externalParticipants: params.externalParticipants,
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
  queryable: Queryable,
  participantId: string,
  state: "removed" | "left"
) {
  await executeSqlOn(
    queryable,
    `
      UPDATE conversation_participants
      SET state = $2, left_at = COALESCE(left_at, NOW())
      WHERE id = $1
    `,
    [participantId, state]
  )
}

async function loadParticipantById(
  queryable: Queryable,
  conversationId: string,
  participantId: string
) {
  const result = await executeSqlOn<{
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
      SELECT id, conversation_id, participant_type,
             workspace_member_id, actor_id, remote_agent_id,
             display_name, state
      FROM conversation_participants
      WHERE conversation_id = $1 AND id = $2
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
  return transaction(async (client) => {
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
    await syncConversationUpsertForWorkspaceMembers(
      client,
      params.workspaceId,
      [
        ...recipients.map((r) => r.workspaceMemberId),
        // Include the removed member so their own view drops the conversation.
        ...(target.workspace_member_id ? [target.workspace_member_id] : []),
      ],
      params.conversationId
    )

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
  createdAt: string
  lastSeenAt: string
}

function mapPushTokenRow(row: Record<string, unknown>): ChatPushTokenRow {
  return {
    id: String(row.id),
    workspaceMemberId: String(row.workspace_member_id),
    platform: row.platform as "ios" | "android" | "web",
    token: String(row.token),
    deviceLabel: (row.device_label as string | null) ?? null,
    createdAt: toIso(row.created_at as string),
    lastSeenAt: toIso(row.last_seen_at as string),
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
  const result = await executeSql<Record<string, unknown>>(
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
  const result = await executeSql<Record<string, unknown>>(
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
  const result = await executeSql<{ id: string }>(
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
      occurredAt: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  })
  return { broadcast: true }
}
