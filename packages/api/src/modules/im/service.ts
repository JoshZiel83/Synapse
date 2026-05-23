import type {
  CurrentUserWeixinBindingSummary,
  ConversationTransportBindingSummary,
  TransportAccountInboundActorMode,
  TransportAccountSummary,
  TransportAccountOwnerScope,
  TransportConversationInboundActorMode,
  TransportConnectionMode,
  TransportDeliveryStatus,
  TransportEndpointSummary,
  TransportEndpointType,
  TransportExternalUserSessionRef,
  TransportExternalUserSummary,
  TransportKind,
  TransportSessionSummary,
} from "@synapse/shared/types"
import { sql } from "kysely"
import { transaction } from "../../infrastructure/database/index.js"
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type TableInsert,
} from "../../infrastructure/database/kysely.js"
import { v4 as uuidv4 } from "uuid"
import { enqueueTransportDeliveryJobs } from "../../workers/queues.js"
import { ensureConversationParticipant } from "../chat/service.js"
import { activateConversationParticipant } from "../chat/participant-activation.js"
import { tryGetConnector } from "./connectors/registry.js"
import {
  assertSupportedConnectionMode,
  assertSupportedEndpointType,
} from "./connectors/index.js"

function parseJsonObject(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? (value as T[]) : []
}

function readTrimmedString(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const entry = value[key]
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim()
    }
  }
  return undefined
}

function assertTransportAccountConfiguration(params: {
  transportKind: TransportKind
  connectionMode: TransportConnectionMode
  status: "active" | "disabled" | "error"
  credentials?: Record<string, unknown>
}) {
  if (params.status === "disabled") {
    return
  }
  const connector = tryGetConnector(params.transportKind)
  if (!connector) {
    throw new Error(
      `No connector registered for transport_kind=${params.transportKind}`
    )
  }
  const result = connector.validateCredentials({
    connectionMode: params.connectionMode,
    credentials: params.credentials || {},
  })
  if (!result.ok) {
    const message = result.errors?.length
      ? result.errors.join("; ")
      : `${params.transportKind} credentials are invalid`
    throw new Error(message)
  }
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : value
}

function normalizeAccountRow(row: any): TransportAccountSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    transportKind: row.transport_kind,
    accountKey: row.account_key,
    displayName: row.display_name,
    ownerScope:
      (row.owner_scope as TransportAccountOwnerScope | undefined) ||
      "workspace",
    ownerWorkspaceMemberId: row.owner_workspace_member_id || undefined,
    inboundActorMode:
      (row.account_inbound_actor_mode as
        | TransportAccountInboundActorMode
        | undefined) ||
      (row.inbound_actor_mode as
        | TransportAccountInboundActorMode
        | undefined) ||
      "none",
    inboundActorId:
      row.account_inbound_actor_id || row.inbound_actor_id || undefined,
    connectionMode: row.connection_mode,
    status: row.status,
    credentials: parseJsonObject(row.credentials),
    config: parseJsonObject(row.config),
    metadata: parseJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  }
}

function normalizeEndpointRow(
  row: any,
  transportKind: TransportKind
): TransportEndpointSummary {
  return {
    id: row.endpoint_id || row.id,
    transportAccountId: row.transport_account_id,
    transportKind,
    endpointType: row.endpoint_type,
    externalId: row.endpoint_external_id || row.external_id,
    parentExternalId: row.parent_external_id || undefined,
    displayName: row.endpoint_display_name || row.display_name || undefined,
    metadata: parseJsonObject(row.endpoint_metadata || row.metadata),
    createdAt: toIsoString(row.endpoint_created_at || row.created_at)!,
    updatedAt: toIsoString(row.endpoint_updated_at || row.updated_at)!,
  }
}

function normalizeBindingRow(row: any): ConversationTransportBindingSummary {
  const account = normalizeAccountRow(row)
  return {
    id: row.binding_id || row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    transportKind: row.transport_kind,
    outboundEnabled: Boolean(row.outbound_enabled),
    inboundActorMode:
      (row.inbound_actor_mode as
        | TransportConversationInboundActorMode
        | undefined) || "inherit_account",
    inboundActorId: row.inbound_actor_id || undefined,
    metadata: parseJsonObject(row.binding_metadata || row.metadata),
    createdAt: toIsoString(row.binding_created_at || row.created_at)!,
    updatedAt: toIsoString(row.binding_updated_at || row.updated_at)!,
    account,
    endpoint: normalizeEndpointRow(row, row.transport_kind),
  }
}

function normalizeTransportSessionRow(row: any): TransportSessionSummary {
  const workspaceId = row.account_workspace_id || row.workspace_id
  const account = normalizeAccountRow({
    ...row,
    workspace_id: workspaceId,
  })
  return {
    id: row.endpoint_id || row.binding_id || row.id,
    workspaceId,
    transportKind: row.transport_kind,
    outboundEnabled: Boolean(row.outbound_enabled),
    inboundActorMode:
      (row.inbound_actor_mode as
        | TransportConversationInboundActorMode
        | undefined) || "inherit_account",
    inboundActorId: row.inbound_actor_id || undefined,
    metadata: parseJsonObject(
      row.binding_metadata || row.endpoint_metadata || row.metadata
    ),
    createdAt: toIsoString(
      row.binding_created_at || row.endpoint_created_at || row.created_at
    )!,
    updatedAt: toIsoString(
      row.binding_updated_at || row.endpoint_updated_at || row.updated_at
    )!,
    conversationId: row.conversation_id || undefined,
    conversationTitle: readTrimmedString(row, "conversation_title"),
    lastInboundAt: toIsoString(row.last_inbound_at),
    lastOutboundAt: toIsoString(row.last_outbound_at),
    account,
    endpoint: normalizeEndpointRow(row, row.transport_kind),
  }
}

function normalizeTransportExternalUserRow(
  row: any
): TransportExternalUserSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    transportAccountId: row.transport_account_id,
    transportKind: row.transport_kind,
    accountDisplayName: row.account_display_name || "Transport account",
    externalId: row.external_id,
    displayName: row.display_name || undefined,
    linkedWorkspaceMemberId: row.linked_workspace_member_id || undefined,
    linkedWorkspaceMemberName: row.linked_workspace_member_name || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
    lastSeenAt: toIsoString(row.last_seen_at),
    sessions: parseJsonArray<TransportExternalUserSessionRef>(row.sessions),
  }
}

function pickCurrentWeixinExternalUser(params: {
  externalUsers: TransportExternalUserSummary[]
  scannerUserId?: string
}) {
  if (params.scannerUserId) {
    return (
      params.externalUsers.find(
        (externalUser) => externalUser.externalId === params.scannerUserId
      ) || null
    )
  }
  return params.externalUsers[0] || null
}

function readPendingAutoLinkWorkspaceMemberId(
  metadata: Record<string, unknown>
) {
  return readTrimmedString(metadata, "pendingAutoLinkWorkspaceMemberId")
}

async function assertWorkspaceActor(params: {
  workspaceId: string
  actorId?: string | null
  label: string
}) {
  const actorId = params.actorId || null
  if (!actorId) {
    throw new Error(`${params.label} is required`)
  }

  const actor = await db
    .selectFrom("actors")
    .select("id")
    .where("id", "=", actorId)
    .where("workspace_id", "=", params.workspaceId)
    .where("is_active", "=", true)
    .limit(1)
    .executeTakeFirst()
  if (!actor?.id) {
    throw new Error(`${params.label} is not available in this workspace`)
  }
  return actorId
}

async function assertTransportAccountOwner(params: {
  workspaceId: string
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
}) {
  if (params.ownerScope === "workspace") {
    if (params.ownerWorkspaceMemberId) {
      throw new Error(
        "Workspace-owned transport account cannot have an owner workspace member"
      )
    }
    return null
  }

  const ownerWorkspaceMemberId = params.ownerWorkspaceMemberId || null
  if (!ownerWorkspaceMemberId) {
    throw new Error(
      "Workspace-member transport account requires ownerWorkspaceMemberId"
    )
  }

  const isWorkspaceMember = await assertWorkspaceMember({
    workspaceId: params.workspaceId,
    workspaceMemberId: ownerWorkspaceMemberId,
  })
  if (!isWorkspaceMember) {
    throw new Error("Transport account owner must be a workspace member")
  }

  return ownerWorkspaceMemberId
}

async function assertTransportAccountInboundActor(params: {
  workspaceId: string
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode: TransportAccountInboundActorMode
  inboundActorId?: string | null
}) {
  if (params.inboundActorMode === "none") {
    return null
  }

  if (params.inboundActorMode === "follow_owner_chief_actor") {
    if (
      params.ownerScope !== "workspace_member" ||
      !params.ownerWorkspaceMemberId
    ) {
      throw new Error(
        "Follow chief actor is only available for workspace-member-owned IM accounts"
      )
    }
    return null
  }

  return assertWorkspaceActor({
    workspaceId: params.workspaceId,
    actorId: params.inboundActorId,
    label: "Inbound actor",
  })
}

async function assertConversationInboundActor(params: {
  workspaceId: string
  inboundActorMode: TransportConversationInboundActorMode
  inboundActorId?: string | null
}) {
  if (params.inboundActorMode !== "specified_actor") {
    return null
  }

  return assertWorkspaceActor({
    workspaceId: params.workspaceId,
    actorId: params.inboundActorId,
    label: "Inbound actor",
  })
}

async function loadTransportAccountRow(workspaceId: string, accountId: string) {
  return db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", accountId)
    .limit(1)
    .executeTakeFirst()
}

async function loadTransportAccountRowByWorkspaceKey(params: {
  workspaceId: string
  transportKind: TransportKind
  accountKey: string
}) {
  return db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("transport_kind", "=", params.transportKind)
    .where("account_key", "=", params.accountKey.trim())
    .limit(1)
    .executeTakeFirst()
}

async function loadTransportAccountRowById(accountId: string) {
  return db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("id", "=", accountId)
    .limit(1)
    .executeTakeFirst()
}

async function loadWorkspaceMemberTransportAccountRow(params: {
  workspaceId: string
  workspaceMemberId: string
  transportKind: TransportKind
}) {
  return db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("transport_kind", "=", params.transportKind)
    .where("owner_scope", "=", "workspace_member")
    .where("owner_workspace_member_id", "=", params.workspaceMemberId)
    .orderBy(
      sql<number>`CASE
        WHEN status = 'active' THEN 0
        WHEN status = 'error' THEN 1
        ELSE 2
      END`
    )
    .orderBy("updated_at", "desc")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst()
}

async function loadWorkspaceMemberDisplayName(params: {
  workspaceId: string
  workspaceMemberId: string
}) {
  const row = await db
    .selectFrom("workspace_members as wm")
    .innerJoin("users as u", "u.id", "wm.user_id")
    .select("u.name as name")
    .where("wm.workspace_id", "=", params.workspaceId)
    .where("wm.id", "=", params.workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  return readTrimmedString((row || {}) as Record<string, unknown>, "name")
}

async function assertConversationParticipants(params: {
  conversationId: string
  participantIds: string[]
}) {
  if (params.participantIds.length === 0) return
  const rows = await db
    .selectFrom("conversation_participants")
    .select("id")
    .where("conversation_id", "=", params.conversationId)
    .where("id", "in", params.participantIds)
    .execute()
  const existing = new Set(rows.map((row) => row.id as string))
  const missing = params.participantIds.filter(
    (participantId) => !existing.has(participantId)
  )
  if (missing.length > 0) {
    throw new Error(
      "One or more target participants do not belong to this conversation"
    )
  }
}

async function assertConversationParticipantType(params: {
  conversationId: string
  participantId?: string | null
  allowedTypes: Array<"actor" | "user" | "external">
  label: string
}) {
  if (!params.participantId) return

  const row = await db
    .selectFrom("conversation_participants")
    .select("participant_kind")
    .where("conversation_id", "=", params.conversationId)
    .where("id", "=", params.participantId)
    .limit(1)
    .executeTakeFirst()
  const participantType = row?.participant_kind as
    | "actor"
    | "user"
    | "external"
    | undefined
  if (!participantType) {
    throw new Error(`${params.label} does not belong to this conversation`)
  }
  if (!params.allowedTypes.includes(participantType)) {
    throw new Error(
      `${params.label} must be one of: ${params.allowedTypes.join(", ")}`
    )
  }
}

function normalizeTransportMessageLinkRow(row: any) {
  const rawReactions = row.external_emoji_reactions
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
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    itemId: row.item_id,
    transportAccountId: row.transport_account_id,
    transportEndpointId: row.transport_endpoint_id,
    transportKind: row.transport_kind as TransportKind,
    direction: row.direction as "inbound" | "outbound",
    deliveryStatus: row.delivery_status as TransportDeliveryStatus,
    externalMessageId: row.external_message_id || undefined,
    externalReplyToId: row.external_reply_to_id || undefined,
    externalThreadId: row.external_thread_id || undefined,
    externalEmojiReactions: reactions,
    metadata: parseJsonObject(row.metadata),
    deliveredAt: toIsoString(row.delivered_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

export async function listTransportAccounts(
  workspaceId: string
): Promise<TransportAccountSummary[]> {
  const rows = await db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at", "desc")
    .execute()
  return rows.map(normalizeAccountRow)
}

export async function getTransportAccountById(accountId: string) {
  const row = await loadTransportAccountRowById(accountId)
  return row ? normalizeAccountRow(row) : null
}

export async function getTransportAccountByKindAndId(params: {
  accountId: string
  transportKind: TransportKind
}) {
  const row = await db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("id", "=", params.accountId)
    .where("transport_kind", "=", params.transportKind)
    .limit(1)
    .executeTakeFirst()
  return row ? normalizeAccountRow(row) : null
}

export async function getTransportAccountByWorkspaceKindAndKey(params: {
  workspaceId: string
  transportKind: TransportKind
  accountKey: string
}) {
  const row = await loadTransportAccountRowByWorkspaceKey(params)
  return row ? normalizeAccountRow(row) : null
}

export async function getCurrentUserWeixinBinding(params: {
  workspaceId: string
  userId: string
}): Promise<CurrentUserWeixinBindingSummary | null> {
  const workspaceMember = await db
    .selectFrom("workspace_members")
    .select("id")
    .where("workspace_id", "=", params.workspaceId)
    .where("user_id", "=", params.userId)
    .limit(1)
    .executeTakeFirst()
  if (!workspaceMember?.id) {
    return null
  }

  const row = await loadWorkspaceMemberTransportAccountRow({
    workspaceId: params.workspaceId,
    workspaceMemberId: workspaceMember.id,
    transportKind: "weixin",
  })
  if (!row) {
    return null
  }

  const account = normalizeAccountRow(row)
  if (account.status !== "active") {
    return null
  }
  const metadata = parseJsonObject(row.metadata)
  const scannerUserId = readTrimmedString(metadata, "scannerUserId")
  const pendingAutoLinkWorkspaceMemberId =
    readPendingAutoLinkWorkspaceMemberId(metadata)
  const externalUsers = await listTransportExternalUsers({
    workspaceId: params.workspaceId,
    transportAccountId: account.id,
  })
  const pendingAutoLinkWorkspaceMemberName = pendingAutoLinkWorkspaceMemberId
    ? await loadWorkspaceMemberDisplayName({
        workspaceId: params.workspaceId,
        workspaceMemberId: pendingAutoLinkWorkspaceMemberId,
      })
    : undefined

  return {
    account,
    scannerUserId,
    pendingAutoLinkWorkspaceMemberId:
      pendingAutoLinkWorkspaceMemberId || undefined,
    pendingAutoLinkWorkspaceMemberName,
    externalUser:
      pickCurrentWeixinExternalUser({ externalUsers, scannerUserId }) ||
      undefined,
  }
}

export async function setCurrentUserWeixinBindingAutoLink(params: {
  workspaceId: string
  userId: string
  targetWorkspaceMemberId?: string | null
}): Promise<CurrentUserWeixinBindingSummary> {
  const binding = await getCurrentUserWeixinBinding({
    workspaceId: params.workspaceId,
    userId: params.userId,
  })
  if (!binding) {
    throw new Error("WeChat binding not found")
  }

  const nextTargetWorkspaceMemberId = params.targetWorkspaceMemberId || null
  if (nextTargetWorkspaceMemberId) {
    const isWorkspaceMember = await assertWorkspaceMember({
      workspaceId: params.workspaceId,
      workspaceMemberId: nextTargetWorkspaceMemberId,
    })
    if (!isWorkspaceMember) {
      throw new Error("Workspace member not found")
    }
  }

  const nextMetadata = {
    ...(binding.account.metadata || {}),
  } as Record<string, unknown>
  if (nextTargetWorkspaceMemberId) {
    nextMetadata.pendingAutoLinkWorkspaceMemberId = nextTargetWorkspaceMemberId
    nextMetadata.pendingAutoLinkMode = "first_inbound_once"
    nextMetadata.pendingAutoLinkConfiguredAt = new Date().toISOString()
  } else {
    delete (nextMetadata as any).pendingAutoLinkWorkspaceMemberId
    delete (nextMetadata as any).pendingAutoLinkMode
    delete (nextMetadata as any).pendingAutoLinkConfiguredAt
  }
  delete (nextMetadata as any).pendingAutoLinkConsumedAt
  delete (nextMetadata as any).pendingAutoLinkConsumedExternalId

  await updateTransportAccount({
    workspaceId: params.workspaceId,
    accountId: binding.account.id,
    metadata: nextMetadata,
  })

  const updatedBinding = await getCurrentUserWeixinBinding({
    workspaceId: params.workspaceId,
    userId: params.userId,
  })
  if (!updatedBinding) {
    throw new Error("WeChat binding not found")
  }
  return updatedBinding
}

export async function linkCurrentUserWeixinBinding(params: {
  workspaceId: string
  userId: string
}): Promise<CurrentUserWeixinBindingSummary> {
  const currentWorkspaceMember = await db
    .selectFrom("workspace_members")
    .select("id")
    .where("workspace_id", "=", params.workspaceId)
    .where("user_id", "=", params.userId)
    .limit(1)
    .executeTakeFirst()
  if (!currentWorkspaceMember?.id) {
    throw new Error("Workspace member not found")
  }

  const binding = await getCurrentUserWeixinBinding(params)
  if (!binding) {
    throw new Error("WeChat binding not found")
  }

  const scannerUserId =
    binding.scannerUserId || binding.externalUser?.externalId
  if (!scannerUserId) {
    throw new Error("WeChat binding does not expose a user ID yet")
  }

  let externalUser = binding.externalUser || null
  if (!externalUser) {
    await ensureTransportAddress({
      workspaceId: params.workspaceId,
      transportAccountId: binding.account.id,
      transportKind: "weixin",
      addressType: "user",
      externalId: scannerUserId,
      displayName: scannerUserId,
      metadata: {
        source: "qr_login",
        scannerUserId,
      },
    })

    const refreshed = await getCurrentUserWeixinBinding(params)
    externalUser = refreshed?.externalUser || null
  }

  if (!externalUser) {
    throw new Error("WeChat user not found")
  }
  if (
    externalUser.linkedWorkspaceMemberId &&
    externalUser.linkedWorkspaceMemberId !== currentWorkspaceMember.id
  ) {
    throw new Error("WeChat user is already linked to another workspace member")
  }

  await setTransportAddressLinkedUser({
    workspaceId: params.workspaceId,
    transportAddressId: externalUser.id,
    workspaceMemberId: currentWorkspaceMember.id,
  })

  const updatedBinding = await getCurrentUserWeixinBinding(params)
  if (!updatedBinding) {
    throw new Error("WeChat binding not found")
  }
  return updatedBinding
}

export function getPendingTransportAccountAutoLinkWorkspaceMemberId(
  account: Pick<TransportAccountSummary, "metadata">
) {
  const metadata = parseJsonObject(account.metadata)
  return readPendingAutoLinkWorkspaceMemberId(metadata) || null
}

export async function consumeTransportAccountAutoLink(params: {
  account: TransportAccountSummary
  transportAddressId: string
  targetWorkspaceMemberId: string
  matchedExternalId: string
}) {
  await setTransportAddressLinkedUser({
    workspaceId: params.account.workspaceId,
    transportAddressId: params.transportAddressId,
    workspaceMemberId: params.targetWorkspaceMemberId,
  })

  const nextMetadata = {
    ...parseJsonObject(params.account.metadata),
    pendingAutoLinkConsumedAt: new Date().toISOString(),
    pendingAutoLinkConsumedExternalId: params.matchedExternalId,
  }
  delete (nextMetadata as any).pendingAutoLinkWorkspaceMemberId
  delete (nextMetadata as any).pendingAutoLinkMode
  delete (nextMetadata as any).pendingAutoLinkConfiguredAt

  return updateTransportAccount({
    workspaceId: params.account.workspaceId,
    accountId: params.account.id,
    metadata: nextMetadata,
  })
}

export async function listActiveTransportAccounts(params?: {
  connectionMode?: TransportConnectionMode
  transportKind?: TransportKind
}) {
  let builder = db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("status", "=", "active")

  if (params?.connectionMode) {
    builder = builder.where("connection_mode", "=", params.connectionMode)
  }
  if (params?.transportKind) {
    builder = builder.where("transport_kind", "=", params.transportKind)
  }

  const rows = await builder.orderBy("created_at", "asc").execute()
  return rows.map(normalizeAccountRow)
}

export async function listTransportSessions(
  workspaceId: string
): Promise<TransportSessionSummary[]> {
  const inboundActivity = db
    .selectFrom("transport_message_links")
    .select("transport_endpoint_id")
    .select(sql<Date | null>`MAX(created_at)`.as("last_inbound_at"))
    .where("direction", "=", "inbound")
    .groupBy("transport_endpoint_id")
    .as("inbound_activity")

  const outboundActivity = db
    .selectFrom("transport_message_links")
    .select("transport_endpoint_id")
    .select(sql<Date | null>`MAX(created_at)`.as("last_outbound_at"))
    .where("direction", "=", "outbound")
    .groupBy("transport_endpoint_id")
    .as("outbound_activity")

  const rows = await db
    .selectFrom("transport_endpoints as te")
    .innerJoin("transport_accounts as ta", "ta.id", "te.transport_account_id")
    .leftJoin(
      "conversation_transport_bindings as ctb",
      "ctb.transport_endpoint_id",
      "te.id"
    )
    .leftJoin("conversations as c", "c.id", "ctb.conversation_id")
    .leftJoin(
      inboundActivity,
      "inbound_activity.transport_endpoint_id",
      "te.id"
    )
    .leftJoin(
      outboundActivity,
      "outbound_activity.transport_endpoint_id",
      "te.id"
    )
    .select([
      "ctb.id as binding_id",
      "ctb.workspace_id",
      "ctb.conversation_id",
      "ctb.outbound_enabled",
      "ctb.inbound_actor_mode",
      "ctb.inbound_actor_id",
      "ctb.metadata as binding_metadata",
      "ctb.created_at as binding_created_at",
      "ctb.updated_at as binding_updated_at",
      "c.title as conversation_title",
      "ta.id",
      "ta.workspace_id as account_workspace_id",
      "ta.account_key",
      "ta.display_name",
      "ta.transport_kind",
      "ta.owner_scope",
      "ta.owner_workspace_member_id",
      "ta.inbound_actor_mode as account_inbound_actor_mode",
      "ta.inbound_actor_id as account_inbound_actor_id",
      "ta.connection_mode",
      "ta.status",
      "ta.credentials",
      "ta.config",
      "ta.metadata",
      "ta.created_at",
      "ta.updated_at",
      "te.id as endpoint_id",
      "te.transport_account_id",
      "te.endpoint_type",
      "te.external_id as endpoint_external_id",
      "te.parent_external_id",
      "te.display_name as endpoint_display_name",
      "te.metadata as endpoint_metadata",
      "te.created_at as endpoint_created_at",
      "te.updated_at as endpoint_updated_at",
      "inbound_activity.last_inbound_at as last_inbound_at",
      "outbound_activity.last_outbound_at as last_outbound_at",
    ])
    .where("ta.workspace_id", "=", workspaceId)
    .orderBy(
      sql`COALESCE(inbound_activity.last_inbound_at, outbound_activity.last_outbound_at, te.updated_at)`,
      "desc"
    )
    .orderBy("te.created_at", "desc")
    .execute()

  return rows.map(normalizeTransportSessionRow)
}

export async function listTransportExternalUsers(params: {
  workspaceId: string
  transportAccountId?: string
}): Promise<TransportExternalUserSummary[]> {
  const activity = db
    .selectFrom("conversation_participant_addresses as cpa_activity")
    .innerJoin(
      "conversation_participants as cm_activity",
      "cm_activity.id",
      "cpa_activity.conversation_participant_id"
    )
    .innerJoin(
      "transport_message_links as tml",
      "tml.conversation_id",
      "cm_activity.conversation_id"
    )
    .select("cpa_activity.transport_address_id")
    .select(sql<Date | null>`MAX(tml.created_at)`.as("last_seen_at"))
    .groupBy("cpa_activity.transport_address_id")
    .as("activity")

  let builder = db
    .selectFrom("transport_addresses as ta")
    .innerJoin(
      "transport_accounts as account",
      "account.id",
      "ta.transport_account_id"
    )
    .leftJoin(
      "workspace_members as linked_wm",
      "linked_wm.id",
      "ta.workspace_member_id"
    )
    .leftJoin("users as linked_user", "linked_user.id", "linked_wm.user_id")
    .leftJoin(
      "conversation_participant_addresses as cpa",
      "cpa.transport_address_id",
      "ta.id"
    )
    .leftJoin(
      "conversation_participants as cm",
      "cm.id",
      "cpa.conversation_participant_id"
    )
    .leftJoin("conversations as c", "c.id", "cm.conversation_id")
    .leftJoin(
      "conversation_transport_bindings as ctb",
      "ctb.conversation_id",
      "c.id"
    )
    .leftJoin("transport_endpoints as te", "te.id", "ctb.transport_endpoint_id")
    .leftJoin(activity, "activity.transport_address_id", "ta.id")
    .select([
      "ta.id",
      "ta.workspace_id",
      "ta.transport_account_id",
      "ta.transport_kind",
      "ta.external_id",
      "ta.display_name",
      "ta.metadata",
      "ta.created_at",
      "ta.updated_at",
      "account.display_name as account_display_name",
      "linked_wm.id as linked_workspace_member_id",
      "linked_user.name as linked_workspace_member_name",
      "activity.last_seen_at as last_seen_at",
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
    .where("ta.workspace_id", "=", params.workspaceId)
    .where("ta.address_type", "=", "user")

  if (params.transportAccountId) {
    builder = builder.where(
      "ta.transport_account_id",
      "=",
      params.transportAccountId
    )
  }

  const rows = await builder
    .groupBy([
      "ta.id",
      "account.display_name",
      "linked_user.id",
      "linked_user.name",
      "activity.last_seen_at",
    ])
    .orderBy(
      sql`COALESCE(activity.last_seen_at, ta.updated_at, ta.created_at)`,
      "desc"
    )
    .orderBy("ta.created_at", "desc")
    .execute()

  return rows.map(normalizeTransportExternalUserRow)
}

export async function createTransportAccount(params: {
  workspaceId: string
  transportKind: TransportKind
  accountKey: string
  displayName: string
  ownerScope?: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode?: TransportAccountInboundActorMode
  inboundActorId?: string | null
  connectionMode: TransportConnectionMode
  status?: "active" | "disabled" | "error"
  credentials?: Record<string, unknown>
  config?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  assertSupportedConnectionMode(params.transportKind, params.connectionMode)
  const nextStatus = params.status || "active"
  assertTransportAccountConfiguration({
    transportKind: params.transportKind,
    connectionMode: params.connectionMode,
    status: nextStatus,
    credentials: params.credentials,
  })
  const ownerScope = params.ownerScope || "workspace"
  const ownerWorkspaceMemberId = await assertTransportAccountOwner({
    workspaceId: params.workspaceId,
    ownerScope,
    ownerWorkspaceMemberId:
      ownerScope === "workspace" ? null : params.ownerWorkspaceMemberId,
  })
  const inboundActorMode = params.inboundActorMode || "none"
  const inboundActorId = await assertTransportAccountInboundActor({
    workspaceId: params.workspaceId,
    ownerScope,
    ownerWorkspaceMemberId,
    inboundActorMode,
    inboundActorId: params.inboundActorId,
  })

  const row = await db
    .insertInto("transport_accounts")
    .values({
      id: uuidv4(),
      workspace_id: params.workspaceId,
      transport_kind: params.transportKind,
      account_key: params.accountKey.trim(),
      display_name: params.displayName.trim(),
      owner_scope: ownerScope,
      owner_workspace_member_id: ownerWorkspaceMemberId,
      inbound_actor_mode: inboundActorMode,
      inbound_actor_id: inboundActorId,
      connection_mode: params.connectionMode,
      status: nextStatus,
      credentials: (params.credentials ||
        {}) as TableInsert<"transport_accounts">["credentials"],
      config: (params.config ||
        {}) as TableInsert<"transport_accounts">["config"],
      metadata: (params.metadata ||
        {}) as TableInsert<"transport_accounts">["metadata"],
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return normalizeAccountRow(row)
}

export async function updateTransportAccount(params: {
  workspaceId: string
  accountId: string
  displayName?: string
  ownerScope?: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode?: TransportAccountInboundActorMode
  inboundActorId?: string | null
  connectionMode?: TransportConnectionMode
  status?: "active" | "disabled" | "error"
  credentials?: Record<string, unknown>
  config?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const existing = await loadTransportAccountRow(
    params.workspaceId,
    params.accountId
  )
  if (!existing) {
    throw new Error("Transport account not found")
  }

  const nextConnectionMode =
    params.connectionMode ||
    (existing.connection_mode as TransportConnectionMode)
  assertSupportedConnectionMode(
    existing.transport_kind as TransportKind,
    nextConnectionMode
  )
  const nextStatus =
    params.status || (existing.status as "active" | "disabled" | "error")
  const nextCredentials = params.credentials
    ? params.credentials
    : parseJsonObject(existing.credentials)
  const nextOwnerScope =
    params.ownerScope ||
    (existing.owner_scope as TransportAccountOwnerScope | undefined) ||
    "workspace"
  const nextOwnerWorkspaceMemberId =
    nextOwnerScope === "workspace"
      ? null
      : params.ownerWorkspaceMemberId !== undefined
        ? params.ownerWorkspaceMemberId
        : (existing.owner_workspace_member_id as string | null | undefined) ||
          null
  assertTransportAccountConfiguration({
    transportKind: existing.transport_kind as TransportKind,
    connectionMode: nextConnectionMode,
    status: nextStatus,
    credentials: nextCredentials,
  })
  const resolvedOwnerWorkspaceMemberId = await assertTransportAccountOwner({
    workspaceId: params.workspaceId,
    ownerScope: nextOwnerScope,
    ownerWorkspaceMemberId: nextOwnerWorkspaceMemberId,
  })
  const nextInboundActorMode =
    params.inboundActorMode ||
    (existing.inbound_actor_mode as
      | TransportAccountInboundActorMode
      | undefined) ||
    "none"
  const nextInboundActorId =
    nextInboundActorMode === "specified_actor"
      ? params.inboundActorId !== undefined
        ? params.inboundActorId
        : (existing.inbound_actor_id as string | null | undefined) || null
      : null
  const resolvedInboundActorId = await assertTransportAccountInboundActor({
    workspaceId: params.workspaceId,
    ownerScope: nextOwnerScope,
    ownerWorkspaceMemberId: resolvedOwnerWorkspaceMemberId,
    inboundActorMode: nextInboundActorMode,
    inboundActorId: nextInboundActorId,
  })
  const row = await db
    .updateTable("transport_accounts")
    .set({
      display_name: params.displayName?.trim() || existing.display_name,
      owner_scope: nextOwnerScope,
      owner_workspace_member_id: resolvedOwnerWorkspaceMemberId,
      inbound_actor_mode: nextInboundActorMode,
      inbound_actor_id: resolvedInboundActorId,
      connection_mode: nextConnectionMode,
      status: nextStatus,
      credentials:
        nextCredentials as TableInsert<"transport_accounts">["credentials"],
      config: (params.config !== undefined
        ? params.config
        : parseJsonObject(
            existing.config
          )) as TableInsert<"transport_accounts">["config"],
      metadata: (params.metadata !== undefined
        ? params.metadata
        : parseJsonObject(
            existing.metadata
          )) as TableInsert<"transport_accounts">["metadata"],
      updated_at: sql`NOW()`,
    })
    .where("workspace_id", "=", params.workspaceId)
    .where("id", "=", params.accountId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return normalizeAccountRow(row)
}

export async function getConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
}) {
  const row = await db
    .selectFrom("conversation_transport_bindings as ctb")
    .innerJoin("transport_accounts as ta", "ta.id", "ctb.transport_account_id")
    .innerJoin(
      "transport_endpoints as te",
      "te.id",
      "ctb.transport_endpoint_id"
    )
    .select([
      "ctb.id as binding_id",
      "ctb.workspace_id",
      "ctb.conversation_id",
      "ctb.outbound_enabled",
      "ctb.inbound_actor_mode",
      "ctb.inbound_actor_id",
      "ctb.metadata as binding_metadata",
      "ctb.created_at as binding_created_at",
      "ctb.updated_at as binding_updated_at",
      "ta.id",
      "ta.account_key",
      "ta.display_name",
      "ta.transport_kind",
      "ta.owner_scope",
      "ta.owner_workspace_member_id",
      "ta.inbound_actor_mode as account_inbound_actor_mode",
      "ta.inbound_actor_id as account_inbound_actor_id",
      "ta.connection_mode",
      "ta.status",
      "ta.credentials",
      "ta.config",
      "ta.metadata",
      "ta.created_at",
      "ta.updated_at",
      "te.id as endpoint_id",
      "te.transport_account_id",
      "te.endpoint_type",
      "te.external_id as endpoint_external_id",
      "te.parent_external_id",
      "te.display_name as endpoint_display_name",
      "te.metadata as endpoint_metadata",
      "te.created_at as endpoint_created_at",
      "te.updated_at as endpoint_updated_at",
    ])
    .where("ctb.workspace_id", "=", params.workspaceId)
    .where("ctb.conversation_id", "=", params.conversationId)
    .limit(1)
    .executeTakeFirst()

  return row ? normalizeBindingRow(row) : null
}

export async function findConversationTransportBindingByEndpoint(params: {
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
}) {
  const row = await db
    .selectFrom("conversation_transport_bindings as ctb")
    .innerJoin("transport_accounts as ta", "ta.id", "ctb.transport_account_id")
    .innerJoin(
      "transport_endpoints as te",
      "te.id",
      "ctb.transport_endpoint_id"
    )
    .select([
      "ctb.id as binding_id",
      "ctb.workspace_id",
      "ctb.conversation_id",
      "ctb.outbound_enabled",
      "ctb.inbound_actor_mode",
      "ctb.inbound_actor_id",
      "ctb.metadata as binding_metadata",
      "ctb.created_at as binding_created_at",
      "ctb.updated_at as binding_updated_at",
      "ta.id",
      "ta.account_key",
      "ta.display_name",
      "ta.transport_kind",
      "ta.owner_scope",
      "ta.owner_workspace_member_id",
      "ta.inbound_actor_mode as account_inbound_actor_mode",
      "ta.inbound_actor_id as account_inbound_actor_id",
      "ta.connection_mode",
      "ta.status",
      "ta.credentials",
      "ta.config",
      "ta.metadata",
      "ta.created_at",
      "ta.updated_at",
      "te.id as endpoint_id",
      "te.transport_account_id",
      "te.endpoint_type",
      "te.external_id as endpoint_external_id",
      "te.parent_external_id",
      "te.display_name as endpoint_display_name",
      "te.metadata as endpoint_metadata",
      "te.created_at as endpoint_created_at",
      "te.updated_at as endpoint_updated_at",
    ])
    .where("ctb.transport_account_id", "=", params.transportAccountId)
    .where("te.endpoint_type", "=", params.endpointType)
    .where("te.external_id", "=", params.endpointExternalId.trim())
    .limit(1)
    .executeTakeFirst()

  return row ? normalizeBindingRow(row) : null
}

export async function upsertConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
  parentExternalId?: string
  endpointDisplayName?: string
  outboundEnabled?: boolean
  inboundActorMode?: TransportConversationInboundActorMode
  inboundActorId?: string | null
  metadata?: Record<string, unknown>
}) {
  const account = await loadTransportAccountRow(
    params.workspaceId,
    params.transportAccountId
  )
  if (!account) {
    throw new Error("Transport account not found")
  }

  assertSupportedEndpointType(
    account.transport_kind as TransportKind,
    params.endpointType
  )
  const inboundActorMode = params.inboundActorMode || "inherit_account"
  const inboundActorId = await assertConversationInboundActor({
    workspaceId: params.workspaceId,
    inboundActorMode,
    inboundActorId: params.inboundActorId,
  })

  await transaction(async (client) => {
    const endpointRow = await executeTakeFirst<{ id: string }>(
      client,
      db
        .insertInto("transport_endpoints")
        .values({
          id: uuidv4(),
          transport_account_id: params.transportAccountId,
          endpoint_type: params.endpointType,
          external_id: params.endpointExternalId.trim(),
          parent_external_id: params.parentExternalId?.trim() || null,
          display_name: params.endpointDisplayName?.trim() || null,
          metadata: (params.metadata ||
            {}) as TableInsert<"transport_endpoints">["metadata"],
          created_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc
            .columns(["transport_account_id", "endpoint_type", "external_id"])
            .doUpdateSet({
              parent_external_id: sql`excluded.parent_external_id`,
              display_name: sql`COALESCE(excluded.display_name, transport_endpoints.display_name)`,
              metadata: sql`transport_endpoints.metadata || excluded.metadata`,
              updated_at: sql`NOW()`,
            })
        )
        .returning("id")
    )
    const endpointId = endpointRow?.id
    if (!endpointId) {
      throw new Error("Failed to upsert transport endpoint")
    }

    await executeCompiledQuery(
      client,
      db
        .insertInto("conversation_transport_bindings")
        .values({
          id: uuidv4(),
          workspace_id: params.workspaceId,
          conversation_id: params.conversationId,
          transport_account_id: params.transportAccountId,
          transport_endpoint_id: endpointId,
          outbound_enabled: params.outboundEnabled ?? true,
          inbound_actor_mode: inboundActorMode,
          inbound_actor_id: inboundActorId,
          metadata: (params.metadata ||
            {}) as TableInsert<"conversation_transport_bindings">["metadata"],
          created_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.column("conversation_id").doUpdateSet({
            transport_account_id: sql`excluded.transport_account_id`,
            transport_endpoint_id: sql`excluded.transport_endpoint_id`,
            outbound_enabled: sql`excluded.outbound_enabled`,
            inbound_actor_mode: sql`excluded.inbound_actor_mode`,
            inbound_actor_id: sql`excluded.inbound_actor_id`,
            metadata: sql`excluded.metadata`,
            updated_at: sql`NOW()`,
          })
        )
    )
  })

  return getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
}

export async function updateConversationTransportSettings(params: {
  workspaceId: string
  conversationId: string
  outboundEnabled?: boolean
  inboundActorMode?: TransportConversationInboundActorMode
  inboundActorId?: string | null
  metadata?: Record<string, unknown>
}) {
  const existing = await getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
  if (!existing) {
    throw new Error("Transport session not found for this conversation")
  }

  const nextInboundActorMode =
    params.inboundActorMode || existing.inboundActorMode
  const nextInboundActorId =
    nextInboundActorMode === "specified_actor"
      ? params.inboundActorId !== undefined
        ? params.inboundActorId
        : existing.inboundActorId || null
      : null
  const resolvedInboundActorId = await assertConversationInboundActor({
    workspaceId: params.workspaceId,
    inboundActorMode: nextInboundActorMode,
    inboundActorId: nextInboundActorId,
  })

  const updates: Record<string, unknown> = {
    updated_at: sql`NOW()`,
  }
  if (params.outboundEnabled !== undefined) {
    updates.outbound_enabled = params.outboundEnabled
  }
  if (
    params.inboundActorMode !== undefined ||
    params.inboundActorId !== undefined
  ) {
    updates.inbound_actor_mode = nextInboundActorMode
    updates.inbound_actor_id = resolvedInboundActorId
  }
  if (params.metadata !== undefined) {
    updates.metadata = {
      ...parseJsonObject(existing.metadata),
      ...(params.metadata || {}),
    } as TableInsert<"conversation_transport_bindings">["metadata"]
  }

  await db
    .updateTable("conversation_transport_bindings")
    .set(updates)
    .where("workspace_id", "=", params.workspaceId)
    .where("conversation_id", "=", params.conversationId)
    .execute()

  return getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
}

export async function updateTransportSessionSettings(params: {
  workspaceId: string
  transportEndpointId: string
  outboundEnabled?: boolean
  inboundActorMode?: TransportConversationInboundActorMode
  inboundActorId?: string | null
  metadata?: Record<string, unknown>
}) {
  const row = await db
    .selectFrom("conversation_transport_bindings")
    .select("conversation_id")
    .where("workspace_id", "=", params.workspaceId)
    .where("transport_endpoint_id", "=", params.transportEndpointId)
    .limit(1)
    .executeTakeFirst()
  const conversationId = row?.conversation_id as string | undefined
  if (!conversationId) {
    throw new Error("Transport session not found")
  }

  await updateConversationTransportSettings({
    workspaceId: params.workspaceId,
    conversationId,
    outboundEnabled: params.outboundEnabled,
    inboundActorMode: params.inboundActorMode,
    inboundActorId: params.inboundActorId,
    metadata: params.metadata,
  })

  const updatedSessions = await listTransportSessions(params.workspaceId)
  return (
    updatedSessions.find(
      (session) => session.id === params.transportEndpointId
    ) || null
  )
}

export async function deleteConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
}) {
  const row = await db
    .deleteFrom("conversation_transport_bindings")
    .where("workspace_id", "=", params.workspaceId)
    .where("conversation_id", "=", params.conversationId)
    .returning("id")
    .executeTakeFirst()
  return Boolean(row)
}

export async function ensureTransportAddress(params: {
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
    .insertInto("transport_addresses")
    .values({
      id: uuidv4(),
      workspace_id: params.workspaceId,
      transport_account_id: params.transportAccountId,
      transport_kind: params.transportKind,
      address_type: params.addressType || "user",
      external_id: params.externalId.trim(),
      display_name: params.displayName?.trim() || null,
      workspace_member_id: params.workspaceMemberId || null,
      metadata: (params.metadata ||
        {}) as TableInsert<"transport_addresses">["metadata"],
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["transport_account_id", "address_type", "external_id"])
        .doUpdateSet({
          display_name: sql`COALESCE(excluded.display_name, transport_addresses.display_name)`,
          workspace_member_id: sql`COALESCE(excluded.workspace_member_id, transport_addresses.workspace_member_id)`,
          metadata: sql`transport_addresses.metadata || excluded.metadata`,
          updated_at: sql`NOW()`,
        })
    )
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function getTransportAddressByExternalId(params: {
  transportAccountId: string
  externalId: string
  addressType?: "user" | "bot" | "system"
}) {
  return db
    .selectFrom("transport_addresses")
    .selectAll()
    .where("transport_account_id", "=", params.transportAccountId)
    .where("address_type", "=", params.addressType || "user")
    .where("external_id", "=", params.externalId.trim())
    .limit(1)
    .executeTakeFirst()
}

export async function getTransportAddressById(transportAddressId: string) {
  return db
    .selectFrom("transport_addresses")
    .selectAll()
    .where("id", "=", transportAddressId)
    .limit(1)
    .executeTakeFirst()
}

export async function getPrimaryTransportAddressForParticipant(params: {
  conversationParticipantId: string
  transportAccountId?: string
}) {
  let builder = db
    .selectFrom("conversation_participant_addresses as cpa")
    .innerJoin("transport_addresses as ta", "ta.id", "cpa.transport_address_id")
    .selectAll("ta")
    .where(
      "cpa.conversation_participant_id",
      "=",
      params.conversationParticipantId
    )

  if (params.transportAccountId) {
    builder = builder.where(
      "ta.transport_account_id",
      "=",
      params.transportAccountId
    )
  }

  return builder
    .orderBy("cpa.is_primary", "desc")
    .orderBy("cpa.created_at", "asc")
    .limit(1)
    .executeTakeFirst()
}

export async function getReachableTransportAddressForParticipant(params: {
  conversationParticipantId: string
  transportAccountId: string
}) {
  const result = await db.executeQuery(
    sql<any>`SELECT candidate.*
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
        JOIN transport_addresses ta
          ON ta.workspace_member_id = cm.workspace_member_id
         AND ta.address_type = 'user'
        WHERE cm.id = ${params.conversationParticipantId}
          AND cm.workspace_member_id IS NOT NULL
          AND ta.transport_account_id = ${params.transportAccountId}
      ) candidate
      ORDER BY candidate.is_attached DESC,
               candidate.is_primary DESC,
               candidate.binding_created_at ASC
      LIMIT 1`.compile(db)
  )
  return result.rows[0] ?? null
}

async function removeConversationParticipantTransportAddress(params: {
  conversationParticipantId: string
  transportAddressId: string
}) {
  await db
    .deleteFrom("conversation_participant_addresses")
    .where("conversation_participant_id", "=", params.conversationParticipantId)
    .where("transport_address_id", "=", params.transportAddressId)
    .execute()
}

async function archiveConversationParticipantIfOrphaned(
  conversationParticipantId: string
) {
  const row = await db
    .selectFrom("conversation_participants as cm")
    .select([
      "cm.participant_kind",
      "cm.state",
      sql<boolean>`EXISTS (
        SELECT 1
        FROM conversation_participant_addresses cpa
        WHERE cpa.conversation_participant_id = cm.id
      )`.as("has_addresses"),
    ])
    .where("cm.id", "=", conversationParticipantId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return
  if (
    row.participant_kind !== "external" ||
    row.state !== "active" ||
    row.has_addresses
  ) {
    return
  }

  await db
    .updateTable("conversation_participants")
    .set({
      state: "left",
      left_at: sql`COALESCE(left_at, NOW())`,
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ retiredByTransportLink: true })}::jsonb`,
    })
    .where("id", "=", conversationParticipantId)
    .execute()
}

export async function syncTransportAddressConversationParticipant(params: {
  conversationId: string
  transportAddressId: string
  workspaceMemberId?: string | null
  displayName?: string
  recordJoinEvent?: boolean
}) {
  const address = await getTransportAddressById(params.transportAddressId)
  if (!address) {
    throw new Error("Transport external user not found")
  }

  const desiredMember = params.workspaceMemberId
    ? (
        await activateConversationParticipant({
          workspaceId: address.workspace_id,
          conversationId: params.conversationId,
          participantKind: "workspace_member",
          workspaceMemberId: params.workspaceMemberId,
          recordJoinEvent: params.recordJoinEvent,
        })
      ).member
    : (
        await activateConversationParticipant({
          workspaceId: address.workspace_id,
          conversationId: params.conversationId,
          participantKind: "external",
          displayName:
            params.displayName ||
            address.display_name ||
            address.external_id ||
            "External user",
          metadata: {
            externalUserKey: `${address.transport_kind}:${address.external_id}`,
          },
          recordJoinEvent: params.recordJoinEvent,
        })
      ).member

  await ensureConversationParticipantTransportAddress({
    conversationParticipantId: desiredMember.id,
    transportAddressId: address.id,
    isPrimary: true,
  })

  const attachedMembers = await db
    .selectFrom("conversation_participant_addresses as cpa")
    .innerJoin(
      "conversation_participants as cm",
      "cm.id",
      "cpa.conversation_participant_id"
    )
    .select(["cm.id", "cm.participant_kind"])
    .where("cpa.transport_address_id", "=", address.id)
    .where("cm.conversation_id", "=", params.conversationId)
    .where("cm.id", "<>", desiredMember.id)
    .execute()

  for (const row of attachedMembers) {
    await removeConversationParticipantTransportAddress({
      conversationParticipantId: row.id,
      transportAddressId: address.id,
    })
    await archiveConversationParticipantIfOrphaned(row.id)
  }

  return desiredMember
}

async function listConversationIdsForTransportAddress(
  transportAddressId: string
) {
  const rows = await db
    .selectFrom("conversation_participant_addresses as cpa")
    .innerJoin(
      "conversation_participants as cm",
      "cm.id",
      "cpa.conversation_participant_id"
    )
    .select("cm.conversation_id")
    .distinct()
    .where("cpa.transport_address_id", "=", transportAddressId)
    .execute()
  return rows.map((row) => row.conversation_id as string).filter(Boolean)
}

async function syncTransportAddressLinkedUserMemberships(params: {
  transportAddressId: string
  workspaceMemberId?: string | null
}) {
  const conversationIds = await listConversationIdsForTransportAddress(
    params.transportAddressId
  )
  for (const conversationId of conversationIds) {
    await syncTransportAddressConversationParticipant({
      conversationId,
      transportAddressId: params.transportAddressId,
      workspaceMemberId: params.workspaceMemberId || null,
      recordJoinEvent: false,
    })
  }
}

async function loadConversationExternalParticipantPrimaryAddress(params: {
  workspaceId: string
  conversationId: string
  conversationParticipantId: string
}) {
  return db
    .selectFrom("conversation_participants as cm")
    .leftJoin(
      "conversation_participant_addresses as cpa",
      "cpa.conversation_participant_id",
      "cm.id"
    )
    .leftJoin("transport_addresses as ta", "ta.id", "cpa.transport_address_id")
    .select([
      "cm.id as conversation_participant_id",
      "ta.id as transport_address_id",
    ])
    .where("cm.conversation_id", "=", params.conversationId)
    .where("cm.id", "=", params.conversationParticipantId)
    .where("cm.participant_kind", "=", "external")
    .where("ta.workspace_id", "=", params.workspaceId)
    .orderBy("cpa.is_primary", "desc")
    .orderBy("cpa.created_at", "asc")
    .limit(1)
    .executeTakeFirst()
}

async function assertWorkspaceMember(params: {
  workspaceId: string
  workspaceMemberId: string
}) {
  const row = await db
    .selectFrom("workspace_members")
    .select("workspace_id")
    .where("workspace_id", "=", params.workspaceId)
    .where("id", "=", params.workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function setConversationExternalParticipantLinkedUser(params: {
  workspaceId: string
  conversationId: string
  conversationParticipantId: string
  workspaceMemberId?: string | null
}) {
  const participantAddress =
    await loadConversationExternalParticipantPrimaryAddress({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      conversationParticipantId: params.conversationParticipantId,
    })
  if (!participantAddress) {
    throw new Error("External participant not found in this conversation")
  }
  if (!participantAddress.transport_address_id) {
    throw new Error("External participant does not have a transport address")
  }

  return setTransportAddressLinkedUser({
    workspaceId: params.workspaceId,
    transportAddressId: participantAddress.transport_address_id as string,
    workspaceMemberId: params.workspaceMemberId,
  })
}

export async function setTransportAddressLinkedUser(params: {
  workspaceId: string
  transportAddressId: string
  workspaceMemberId?: string | null
}) {
  const nextWorkspaceMemberId = params.workspaceMemberId || null
  if (nextWorkspaceMemberId) {
    const isWorkspaceMember = await assertWorkspaceMember({
      workspaceId: params.workspaceId,
      workspaceMemberId: nextWorkspaceMemberId,
    })
    if (!isWorkspaceMember) {
      throw new Error("Workspace member not found")
    }
  }

  const row = await db
    .updateTable("transport_addresses")
    .set({
      workspace_member_id: nextWorkspaceMemberId,
      updated_at: sql`NOW()`,
    })
    .where("workspace_id", "=", params.workspaceId)
    .where("id", "=", params.transportAddressId)
    .where("address_type", "=", "user")
    .returningAll()
    .executeTakeFirst()
  if (!row) {
    throw new Error("Transport external user not found")
  }

  await syncTransportAddressLinkedUserMemberships({
    transportAddressId: params.transportAddressId,
    workspaceMemberId: nextWorkspaceMemberId,
  })

  return row
}

export async function ensureConversationParticipantTransportAddress(params: {
  conversationParticipantId: string
  transportAddressId: string
  isPrimary?: boolean
  metadata?: Record<string, unknown>
}) {
  if (params.isPrimary) {
    await db
      .updateTable("conversation_participant_addresses")
      .set({
        is_primary: false,
        updated_at: sql`NOW()`,
      })
      .where(
        "conversation_participant_id",
        "=",
        params.conversationParticipantId
      )
      .execute()
  }

  return db
    .insertInto("conversation_participant_addresses")
    .values({
      conversation_participant_id: params.conversationParticipantId,
      transport_address_id: params.transportAddressId,
      is_primary: params.isPrimary ?? false,
      metadata: (params.metadata ||
        {}) as TableInsert<"conversation_participant_addresses">["metadata"],
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["conversation_participant_id", "transport_address_id"])
        .doUpdateSet({
          is_primary: sql`CASE
            WHEN excluded.is_primary THEN TRUE
            ELSE conversation_participant_addresses.is_primary
          END`,
          metadata: sql`conversation_participant_addresses.metadata || excluded.metadata`,
          updated_at: sql`NOW()`,
        })
    )
    .returningAll()
    .executeTakeFirst()
}

export async function updateTransportAddressMetadata(params: {
  transportAddressId: string
  metadata: Record<string, unknown>
}) {
  return db
    .updateTable("transport_addresses")
    .set({
      metadata: sql`transport_addresses.metadata || ${JSON.stringify(params.metadata || {})}::jsonb`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", params.transportAddressId)
    .returningAll()
    .executeTakeFirst()
}

export async function updateTransportEndpointMetadata(params: {
  endpointId: string
  metadata: Record<string, unknown>
}) {
  return db
    .updateTable("transport_endpoints")
    .set({
      metadata: sql`transport_endpoints.metadata || ${JSON.stringify(params.metadata || {})}::jsonb`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", params.endpointId)
    .returningAll()
    .executeTakeFirst()
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
      console.error(
        `[im] Failed to enqueue transport delivery job for link ${link.id}:`,
        error
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
 * Reaction persistence helpers — re-exported from service/reactions-storage.ts.
 * Importers can keep using `from "./service.js"` while the implementation
 * lives in the per-domain sub-file.
 */
export {
  loadTransportEmojiReactions,
  saveTransportEmojiReactions,
  findExternalMessageIdForItem,
} from "./service/reactions-storage.js"
