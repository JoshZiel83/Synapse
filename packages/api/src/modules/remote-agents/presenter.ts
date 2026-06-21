import {
  REMOTE_AGENT_BINDING_STATUS,
  REMOTE_AGENT_RUNTIME_STATE,
  type RemoteAgentBindingStatus,
  type RemoteAgentRuntimeCapabilityView,
  type RemoteAgentLifecycleState,
  type RemoteAgentMachineTrustStatus,
  type RemoteAgentRuntimeCatalogStatus,
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
export type RemoteAgentRuntimeCapabilityRecord =
  RemoteAgentRuntimeCapabilityView

/** Shape of the runtime columns selected alongside an agent/binding row. */
export type RuntimeSummaryRow = {
  runtimeKind: RemoteAgentRuntimeKind
  runtimeState?: RemoteAgentRuntimeStateType | null
  statusText?: string | null
  latestRuntimeSessionId?: string | null
  latestActiveConversationId?: string | null
  latestActiveTaskId?: string | null
  lastActivityAt?: Date | null
  latestLastRunStartedAt?: Date | null
  latestLastRunFinishedAt?: Date | null
  lastError?: string | null
  capabilities?: unknown
  pendingConversationCount?: string | number | null
  unreadDeliveryCount?: string | number | null
}

export function presentRuntimeSummary(
  row: RuntimeSummaryRow
): RemoteAgentRuntimeSummaryView {
  return {
    runtimeKind: row.runtimeKind,
    state: row.runtimeState ?? REMOTE_AGENT_RUNTIME_STATE.OFFLINE,
    statusText: row.statusText ?? undefined,
    sessionId: row.latestRuntimeSessionId ?? undefined,
    activeConversationId: row.latestActiveConversationId ?? undefined,
    activeTaskId: row.latestActiveTaskId ?? undefined,
    pendingConversationCount: Number(row.pendingConversationCount ?? 0),
    unreadDeliveryCount: Number(row.unreadDeliveryCount ?? 0),
    lastActivityAt: serializeOptionalInstant(row.lastActivityAt),
    lastRunStartedAt: serializeOptionalInstant(row.latestLastRunStartedAt),
    lastRunFinishedAt: serializeOptionalInstant(row.latestLastRunFinishedAt),
    lastError: row.lastError ?? undefined,
    capabilities:
      row.capabilities && typeof row.capabilities === "object"
        ? (row.capabilities as RuntimeCapabilities)
        : {},
  }
}

/** Shape of the full agent row (plus joined binding/runtime columns). */
export type RemoteAgentRow = RuntimeSummaryRow & {
  id: string
  workspaceId: string
  displayName: string
  title: string
  description: string | null
  runtimeKind: RemoteAgentRuntimeKind
  avatarFileId: string | null
  avatarEmoji: string | null
  isActive: boolean
  isPublicShared: boolean
  metadata: unknown
  ownerWorkspaceMemberId: string | null
  createdAt: Date
  updatedAt: Date
  machineId?: string | null
  machineTitle?: string | null
  bindingStatus?: RemoteAgentBindingStatus | null
  runtimePath?: string | null
  localRootPath?: string | null
  machineLifecycleState?: RemoteAgentLifecycleState | null
}

/**
 * Domain record handed to the controller for a single remote agent: the joined
 * agent/binding row plus the `requiresContactApproval` flag the service derives
 * via a DB read. {@link presentRemoteAgent} turns this into the app View.
 */
export type RemoteAgentRecord = RemoteAgentRow & {
  requiresContactApproval: boolean
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
  const runtimeSummary = row.machineId ? presentRuntimeSummary(row) : undefined
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    displayName: row.displayName,
    title: row.title,
    description: row.description ?? undefined,
    runtimeKind: row.runtimeKind,
    avatarFileId: row.avatarFileId ?? undefined,
    avatarEmoji: row.avatarEmoji ?? undefined,
    requiresContactApproval,
    isActive: row.isActive,
    isPublicShared: row.isPublicShared,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId ?? undefined,
    createdAt: serializeInstant(
      requireInstantDate(row.createdAt, `Remote agent ${row.id} created_at`)
    ),
    updatedAt: serializeInstant(
      requireInstantDate(row.updatedAt, `Remote agent ${row.id} updated_at`)
    ),
    runtimeSummary,
    binding: row.machineId
      ? {
          machineId: row.machineId,
          machineTitle: row.machineTitle ?? undefined,
          status: row.bindingStatus ?? REMOTE_AGENT_BINDING_STATUS.ACTIVE,
          runtimePath: row.runtimePath ?? undefined,
          localRootPath: row.localRootPath ?? undefined,
          machineLifecycleState: row.machineLifecycleState ?? undefined,
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

/** Record shape consumed by {@link presentMachineFromCamelRow}. */
export type MachineRecord = {
  id: string
  workspaceId: string
  title: string
  description: string | null
  trustStatus: RemoteAgentMachineTrustStatus
  lifecycleState?: RemoteAgentLifecycleState | null
  lastSeenAt?: Date | null
  createdAt?: Date | null
  updatedAt?: Date | null
}

/** Present an inserted machine row (camelCase columns). */
export function presentMachineFromCamelRow(row: MachineRecord) {
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

/** Record shape consumed by {@link presentMachineListItem}. */
export type MachineListRecord = {
  id: string
  workspaceId: string
  title: string
  description: string | null
  trustStatus: RemoteAgentMachineTrustStatus
  lifecycleState?: RemoteAgentLifecycleState | null
  bindingCount?: string | number | null
  lastSeenAt?: Date | null
  createdAt?: Date | null
  updatedAt?: Date | null
}

/** Present a machine list-row (camelCase columns) with binding count. */
export function presentMachineListItem(row: MachineListRecord) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description ?? undefined,
    trustStatus: row.trustStatus,
    lifecycleState: row.lifecycleState ?? undefined,
    bindingCount: Number(row.bindingCount ?? 0),
    lastSeenAt: serializeOptionalInstant(row.lastSeenAt),
    createdAt: serializeOptionalInstant(row.createdAt),
    updatedAt: serializeOptionalInstant(row.updatedAt),
  }
}

/** Record shape consumed by {@link presentRuntimeCatalogEntry}. */
export type RuntimeCatalogRecord = {
  runtimeKind: RemoteAgentRuntimeKind
  executablePath?: string | null
  status: RemoteAgentRuntimeCatalogStatus
  version?: string | null
  metadata?: unknown
  lastError?: string | null
  lastSeenAt?: Date | null
}

/** Present a runtime catalog entry row (camelCase columns). */
export function presentRuntimeCatalogEntry(row: RuntimeCatalogRecord) {
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

/**
 * Record shape consumed by {@link presentMachineBinding}: a machine-detail
 * binding row plus the joined runtime-summary columns.
 */
export type MachineBindingRecord = RuntimeSummaryRow & {
  remoteAgentId: string
  displayName: string
  runtimePath?: string | null
  localRootPath?: string | null
  status: RemoteAgentBindingStatus
}

/** Present a machine-detail binding row (with its nested runtime summary). */
export function presentMachineBinding(row: MachineBindingRecord) {
  return {
    remoteAgentId: row.remoteAgentId,
    displayName: row.displayName,
    runtimeKind: row.runtimeKind,
    runtimePath: row.runtimePath ?? undefined,
    localRootPath: row.localRootPath ?? undefined,
    status: row.status,
    runtimeSummary: presentRuntimeSummary(row),
  }
}

/** Record shape consumed by {@link presentGroupTaskGrant}. */
export type GroupTaskGrantRecord = {
  workspaceMemberId: string
  createdByWorkspaceMemberId: string | null
  createdAt: Date
  updatedAt: Date
  userId: string
  userName: string | null
}

/** Present a group-task-grant row. `avatarUrl` is resolved by the caller. */
export function presentGroupTaskGrant(
  row: GroupTaskGrantRecord,
  avatarUrl: string | undefined
) {
  return {
    workspaceMemberId: row.workspaceMemberId,
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId ?? undefined,
    createdAt: serializeInstant(
      requireInstantDate(
        row.createdAt,
        "remote_agent_group_task_grants.created_at"
      )
    ),
    updatedAt: serializeInstant(
      requireInstantDate(
        row.updatedAt,
        "remote_agent_group_task_grants.updated_at"
      )
    ),
    userId: row.userId,
    name: row.userName ?? "Unknown user",
    avatarUrl,
  }
}

/** Record shape consumed by {@link presentRemoteAgentConversation}. */
export type RemoteAgentConversationRecord = {
  id: string
  kind: string
  isIm?: unknown
  title?: string | null
  unreadCount?: string | number | null
  updatedAt?: Date | null
}

/** Present a remote-agent conversation list-row. */
export function presentRemoteAgentConversation(
  row: RemoteAgentConversationRecord
) {
  return {
    id: row.id,
    kind: row.kind,
    isIm: Boolean(row.isIm),
    title: row.title ?? undefined,
    unreadCount: Number(row.unreadCount ?? 0),
    updatedAt: serializeOptionalInstant(row.updatedAt),
  }
}

/** Record shape consumed by {@link presentMessageDelivery}. */
export type MessageDeliveryRecord = {
  id: string
  conversationId: string
  itemId: string
  sequence: string | number
  createdAt: Date
  status: string
}

/** Present a pending message-delivery row for the daemon poll response. */
export function presentMessageDelivery(row: MessageDeliveryRecord) {
  return {
    deliveryId: row.id,
    conversationId: row.conversationId,
    itemId: row.itemId,
    sequence: Number(row.sequence),
    createdAt: serializeInstant(
      requireInstantDate(
        row.createdAt,
        "remote_agent_message_deliveries.created_at"
      )
    ),
    status: row.status,
  }
}
