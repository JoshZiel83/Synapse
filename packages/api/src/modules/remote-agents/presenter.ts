import {
  REMOTE_AGENT_RUNTIME_STATE,
  type RemoteAgentRuntimeCapabilityView,
  type RemoteAgentRuntimeKind,
  type RemoteAgentRuntimeStateType,
  type RemoteAgentRuntimeState,
  type RemoteAgentRuntimeSummaryView,
} from "@synapse/shared"
import {
  requireInstantDate,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"

/**
 * Remote-agents presentation layer: DB row → app-facing view. Owns the outward
 * semantic transforms (Date → IsoInstantString) so the service/controller never
 * call serializeInstant/serializeOptionalInstant (guard-layering r3) and so the
 * row→view mappers live outside service.ts (guard-layering r4). See §5.1 / §10.1.
 *
 * Row shapes are taken structurally; this file does NOT import generated/db or
 * use TableRow.
 */

type RuntimeCapabilities = RemoteAgentRuntimeCapabilityView

/** Shape of the runtime columns selected alongside an agent/binding row. */
export type RuntimeSummaryRow = {
  runtime_kind: RemoteAgentRuntimeKind
  runtime_state?: RemoteAgentRuntimeStateType | null
  status_text?: string | null
  latest_runtime_session_id?: string | null
  latest_active_conversation_id?: string | null
  latest_active_task_id?: string | null
  last_activity_at?: Date | null
  latest_last_run_started_at?: Date | null
  latest_last_run_finished_at?: Date | null
  last_error?: string | null
  capabilities?: unknown
  pending_conversation_count?: string | number | null
  unread_delivery_count?: string | number | null
}

export function presentRuntimeSummary(
  row: RuntimeSummaryRow
): RemoteAgentRuntimeSummaryView {
  return {
    runtimeKind: row.runtime_kind,
    state: row.runtime_state ?? REMOTE_AGENT_RUNTIME_STATE.OFFLINE,
    statusText: row.status_text ?? undefined,
    sessionId: row.latest_runtime_session_id ?? undefined,
    activeConversationId: row.latest_active_conversation_id ?? undefined,
    activeTaskId: row.latest_active_task_id ?? undefined,
    pendingConversationCount: Number(row.pending_conversation_count ?? 0),
    unreadDeliveryCount: Number(row.unread_delivery_count ?? 0),
    lastActivityAt: serializeOptionalInstant(row.last_activity_at),
    lastRunStartedAt: serializeOptionalInstant(row.latest_last_run_started_at),
    lastRunFinishedAt: serializeOptionalInstant(
      row.latest_last_run_finished_at
    ),
    lastError: row.last_error ?? undefined,
    capabilities:
      row.capabilities && typeof row.capabilities === "object"
        ? (row.capabilities as RuntimeCapabilities)
        : {},
  }
}

/** Shape of the full agent row (plus joined binding/runtime columns). */
export type RemoteAgentRow = RuntimeSummaryRow & {
  id: string
  workspace_id: string
  display_name: string
  title: string
  description: string | null
  runtime_kind: RemoteAgentRuntimeKind
  avatar_file_id: string | null
  avatar_emoji: string | null
  is_active: boolean
  is_public_shared: boolean
  metadata: unknown
  owner_workspace_member_id: string | null
  created_at: Date
  updated_at: Date
  machine_id?: string | null
  machine_title?: string | null
  binding_status?: string | null
  runtime_path?: string | null
  local_root_path?: string | null
  machine_lifecycle_state?: string | null
}

/**
 * Present a remote-agent row as a RemoteAgentView. `requiresContactApproval` is
 * derived by the caller (it needs a DB read) and injected here so this stays a
 * pure synchronous presentation transform.
 */
export function presentRemoteAgent(
  row: RemoteAgentRow,
  requiresContactApproval: boolean
) {
  const runtimeSummary = row.machine_id ? presentRuntimeSummary(row) : undefined
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    title: row.title,
    description: row.description ?? undefined,
    runtimeKind: row.runtime_kind,
    avatarFileId: row.avatar_file_id ?? undefined,
    avatarEmoji: row.avatar_emoji ?? undefined,
    requiresContactApproval,
    isActive: row.is_active,
    isPublicShared: row.is_public_shared,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    ownerWorkspaceMemberId: row.owner_workspace_member_id ?? undefined,
    createdAt: serializeInstant(
      requireInstantDate(row.created_at, `Remote agent ${row.id} created_at`)
    ),
    updatedAt: serializeInstant(
      requireInstantDate(row.updated_at, `Remote agent ${row.id} updated_at`)
    ),
    runtimeSummary,
    binding: row.machine_id
      ? {
          machineId: row.machine_id,
          machineTitle: row.machine_title ?? undefined,
          status: row.binding_status ?? "active",
          runtimePath: row.runtime_path ?? undefined,
          localRootPath: row.local_root_path ?? undefined,
          machineLifecycleState: row.machine_lifecycle_state ?? undefined,
          runtimeSummary,
        }
      : undefined,
  }
}

/** Inputs for presenting a per-conversation/binding runtime snapshot. */
export type RuntimeSnapshotInput = {
  remoteAgentId: string
  runtimeKind: RemoteAgentRuntimeKind
  state: RemoteAgentRuntimeState["state"]
  statusText?: string | null
  latestActiveConversationId?: string | null
  latestActiveTaskId?: string | null
  latestRuntimeSessionId?: string | null
  pendingConversationCount?: string | number | null
  unreadDeliveryCount?: string | number | null
  lastActivityAt?: Date | null
  latestLastRunStartedAt?: Date | null
  latestLastRunFinishedAt?: Date | null
  lastErrorMessage?: string | null
  lastErrorActivityAt?: Date | null
  /** Fallback timestamp used for both `updatedAt` and `lastError.at`. */
  updatedAtSource: Date
  updatedAtErrorLabel: string
  capabilities?: unknown
}

export function presentRuntimeSnapshot(input: RuntimeSnapshotInput) {
  const updatedAt = serializeInstant(
    requireInstantDate(input.updatedAtSource, input.updatedAtErrorLabel)
  )
  const lastErrorAt =
    serializeOptionalInstant(input.lastErrorActivityAt) ||
    serializeInstant(
      requireInstantDate(input.updatedAtSource, input.updatedAtErrorLabel)
    )
  return {
    remoteAgentId: input.remoteAgentId,
    runtimeKind: input.runtimeKind,
    state: input.state,
    statusText: input.statusText ?? undefined,
    activeConversationId: input.latestActiveConversationId ?? undefined,
    activeTaskId: input.latestActiveTaskId ?? undefined,
    sessionId: input.latestRuntimeSessionId ?? undefined,
    pendingConversationCount: Number(input.pendingConversationCount ?? 0),
    unreadDeliveryCount: Number(input.unreadDeliveryCount ?? 0),
    lastActivityAt: serializeOptionalInstant(input.lastActivityAt),
    lastRunStartedAt: serializeOptionalInstant(input.latestLastRunStartedAt),
    lastRunFinishedAt: serializeOptionalInstant(input.latestLastRunFinishedAt),
    lastError:
      input.lastErrorMessage && lastErrorAt
        ? {
            message: input.lastErrorMessage,
            at: lastErrorAt,
          }
        : undefined,
    updatedAt,
    capabilities:
      input.capabilities && typeof input.capabilities === "object"
        ? (input.capabilities as RuntimeCapabilities)
        : {},
  }
}

/** Present an inserted machine row (camelCase columns). */
export function presentMachineFromCamelRow(row: {
  id: string
  workspaceId: string
  title: string
  description: string | null
  trustStatus: string
  lifecycleState?: string | null
  lastSeenAt?: Date | null
  createdAt?: Date | null
  updatedAt?: Date | null
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description ?? undefined,
    trustStatus: row.trustStatus,
    lifecycleState: row.lifecycleState ?? undefined,
    lastSeenAt: serializeOptionalInstant(row.lastSeenAt),
    createdAt: serializeOptionalInstant(row.createdAt),
    updatedAt: serializeOptionalInstant(row.updatedAt),
  }
}

/** Present a machine list-row (snake_case columns) with binding count. */
export function presentMachineListItem(row: {
  id: string
  workspace_id: string
  title: string
  description: string | null
  trust_status: string
  lifecycle_state?: string | null
  binding_count?: string | number | null
  last_seen_at?: Date | null
  created_at?: Date | null
  updated_at?: Date | null
}) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description ?? undefined,
    trustStatus: row.trust_status,
    lifecycleState: row.lifecycle_state ?? undefined,
    bindingCount: Number(row.binding_count ?? 0),
    lastSeenAt: serializeOptionalInstant(row.last_seen_at),
    createdAt: serializeOptionalInstant(row.created_at),
    updatedAt: serializeOptionalInstant(row.updated_at),
  }
}

/** Present a runtime catalog entry row (camelCase columns). */
export function presentRuntimeCatalogEntry(row: {
  runtimeKind: RemoteAgentRuntimeKind
  executablePath?: string | null
  status: string
  version?: string | null
  metadata?: unknown
  lastError?: string | null
  lastSeenAt?: Date | null
}) {
  return {
    runtimeKind: row.runtimeKind,
    executablePath: row.executablePath ?? undefined,
    status: row.status,
    version: row.version ?? undefined,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    lastError: row.lastError ?? undefined,
    lastSeenAt: serializeOptionalInstant(row.lastSeenAt),
  }
}

/** Present a group-task-grant row. `avatarUrl` is resolved by the caller. */
export function presentGroupTaskGrant(
  row: {
    workspace_member_id: string
    granted_by_workspace_member_id: string | null
    created_at: Date
    updated_at: Date
    user_id: string
    user_name: string | null
  },
  avatarUrl: string | undefined
) {
  return {
    workspaceMemberId: row.workspace_member_id,
    grantedByWorkspaceMemberId: row.granted_by_workspace_member_id ?? undefined,
    createdAt: serializeInstant(
      requireInstantDate(
        row.created_at,
        "remote_agent_group_task_grants.created_at"
      )
    ),
    updatedAt: serializeInstant(
      requireInstantDate(
        row.updated_at,
        "remote_agent_group_task_grants.updated_at"
      )
    ),
    userId: row.user_id,
    name: row.user_name ?? "Unknown user",
    avatarUrl,
  }
}

/** Present a remote-agent conversation list-row. */
export function presentRemoteAgentConversation(row: {
  id: string
  kind: string
  is_im?: unknown
  title?: string | null
  unread_count?: string | number | null
  updated_at?: Date | null
}) {
  return {
    id: row.id,
    kind: row.kind,
    isIm: Boolean(row.is_im),
    title: row.title ?? undefined,
    unreadCount: Number(row.unread_count ?? 0),
    updatedAt: serializeOptionalInstant(row.updated_at),
  }
}

/** Present a pending message-delivery row for the daemon poll response. */
export function presentMessageDelivery(row: {
  id: string
  conversation_id: string
  item_id: string
  sequence: string | number
  created_at: Date
  status: string
}) {
  return {
    deliveryId: row.id,
    conversationId: row.conversation_id,
    itemId: row.item_id,
    sequence: Number(row.sequence),
    createdAt: serializeInstant(
      requireInstantDate(
        row.created_at,
        "remote_agent_message_deliveries.created_at"
      )
    ),
    status: row.status,
  }
}
