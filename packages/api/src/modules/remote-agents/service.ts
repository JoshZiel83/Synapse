import crypto, { createHash, randomBytes } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { config } from "../../config/index.js"
import { transaction } from "../../infrastructure/database/index.js"
import {
  executeSql,
  executeSqlOn,
} from "../../infrastructure/database/kysely.js"
import type { Queryable } from "../../infrastructure/events/index.js"
import { authorizeAction } from "../access/service.js"
import {
  getConversationParticipant,
  listVisibleConversationItemsForParticipant,
  requireRemoteAgentConversationAccess,
  sendConversationMessageFromParticipant,
} from "../chat/service.js"
import { getFileUrlById } from "../files/service.js"
import { requireWorkspaceMemberIdentity } from "../chat/workspace-identity.js"

type RemoteAgentRuntimeKind = "claude_code" | "codex"
type RemoteAgentAccessPolicy = "workspace_open" | "approval_required"
type RemoteAgentRuntimeState =
  | "offline"
  | "idle"
  | "running"
  | "waiting_user_input"
  | "plan_drafting"
  | "waiting_plan_approval"
  | "error"

type RuntimeCapabilities = {
  supportsRequestUserInput?: boolean
  supportsPlanMode?: boolean
  supportsPersistentSession?: boolean
  supportsCodexAppServer?: boolean
  supportsStructuredIo?: boolean
}

type MachineConnection = {
  machineId: string
  workspaceId: string
  sessionId: string
  socket: any
  ready: boolean
}

type RuntimeCatalogEntry = {
  runtimeKind: RemoteAgentRuntimeKind
  executablePath?: string
  status:
    | "available"
    | "missing_binary"
    | "broken_path"
    | "unsupported_platform"
    | "runtime_error"
  version?: string
  metadata?: Record<string, unknown>
  lastError?: string
}

type RuntimeStatusMessage = {
  type: "agent:status"
  remoteAgentId: string
  state: RemoteAgentRuntimeState
  statusText?: string
  conversationId?: string | null
  interactionId?: string | null
  sessionId?: string | null
  lastError?: string | null
  runKey?: string | null
  capabilities?: RuntimeCapabilities
}

type DeliveryRow = {
  id: string
  remote_agent_id: string
  conversation_id: string
  item_id: string
  status: string
  created_at: string | Date
  sequence: string | number
}

const machineConnections = new Map<string, MachineConnection>()

function toIso(value: string | Date | null | undefined) {
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return undefined
}

function hashMachineApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex")
}

function buildDaemonCommand(apiKey: string) {
  return `npx @synapse/remote-agent-daemon --server-url ${config.app.baseUrl} --api-key ${apiKey}`
}

function safeSend(connection: MachineConnection, payload: unknown) {
  if (!connection.ready || connection.socket.readyState !== 1) {
    return false
  }
  try {
    connection.socket.send(JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

async function loadMachineByApiKey(apiKey: string) {
  const result = await executeSql<{
    id: string
    workspace_id: string
    trust_status: string
  }>(
    `
      SELECT id, workspace_id, trust_status
      FROM remote_agent_machines
      WHERE api_key_hash = $1
      LIMIT 1
    `,
    [hashMachineApiKey(apiKey)]
  )
  return result.rows[0] ?? null
}

async function loadBoundRemoteAgentsForMachine(machineId: string) {
  const result = await executeSql<{
    remote_agent_id: string
    runtime_kind: RemoteAgentRuntimeKind
    runtime_path: string | null
    local_root_path: string | null
    last_session_id: string | null
  }>(
    `
      SELECT
        binding.remote_agent_id,
        binding.runtime_kind,
        binding.runtime_path,
        binding.local_root_path,
        binding.last_session_id
      FROM remote_agent_bindings binding
      INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
      WHERE binding.machine_id = $1
        AND binding.status = 'active'
        AND agent.is_active = TRUE
      ORDER BY agent.created_at ASC, agent.id ASC
    `,
    [machineId]
  )
  return result.rows
}

async function setMachineLifecycleState(
  machineId: string,
  state: "online" | "offline",
  queryable: Queryable = {
    query: (text, params) => executeSql(text, params),
  }
) {
  await executeSqlOn(
    queryable,
    `
      UPDATE remote_agent_machines
      SET lifecycle_state = $2,
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [machineId, state]
  )
}

async function upsertRuntimeCatalog(
  machineId: string,
  entries: RuntimeCatalogEntry[],
  queryable: Queryable = {
    query: (text, params) => executeSql(text, params),
  }
) {
  for (const entry of entries) {
    await executeSqlOn(
      queryable,
      `
        INSERT INTO remote_agent_runtime_catalog (
          machine_id,
          runtime_kind,
          executable_path,
          status,
          version,
          metadata,
          last_seen_at,
          last_error,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), $7, NOW(), NOW())
        ON CONFLICT (machine_id, runtime_kind) DO UPDATE
        SET executable_path = EXCLUDED.executable_path,
            status = EXCLUDED.status,
            version = EXCLUDED.version,
            metadata = EXCLUDED.metadata,
            last_seen_at = NOW(),
            last_error = EXCLUDED.last_error,
            updated_at = NOW()
      `,
      [
        machineId,
        entry.runtimeKind,
        entry.executablePath ?? null,
        entry.status,
        entry.version ?? null,
        JSON.stringify(entry.metadata ?? {}),
        entry.lastError ?? null,
      ]
    )
  }
}

async function startBoundRemoteAgents(machineId: string) {
  const connection = machineConnections.get(machineId)
  if (!connection || !connection.ready) {
    return
  }

  const bindings = await loadBoundRemoteAgentsForMachine(machineId)
  for (const binding of bindings) {
    safeSend(connection, {
      type: "agent:start",
      remoteAgentId: binding.remote_agent_id,
      runtimeKind: binding.runtime_kind,
      runtimePath: binding.runtime_path,
      localRootPath: binding.local_root_path,
      sessionId: binding.last_session_id,
      serverUrl: config.app.baseUrl,
    })
  }

  if (bindings.length > 0) {
    await notifyPendingRemoteAgentDeliveries({
      machineId,
      remoteAgentIds: bindings.map((binding) => binding.remote_agent_id),
    })
  }
}

async function updateRemoteAgentRuntimeStatus(
  machineId: string,
  message: RuntimeStatusMessage,
  queryable: Queryable = {
    query: (text, params) => executeSql(text, params),
  }
) {
  const runStatus =
    message.state === "offline"
      ? "cancelled"
      : message.state === "error"
        ? "failed"
        : message.state === "idle"
          ? "completed"
          : "running"
  const runId =
    message.runKey && message.runKey.trim()
      ? await ensureRemoteAgentRun({
          remoteAgentId: message.remoteAgentId,
          conversationId: message.conversationId ?? null,
          runKey: message.runKey,
          status: runStatus,
          statusText: message.statusText,
          lastError: message.lastError ?? null,
          queryable,
        })
      : null

  await executeSqlOn(
    queryable,
    `
      UPDATE remote_agent_bindings
      SET runtime_state = $3::remote_agent_bindings_runtime_state,
          status_text = $4,
          active_conversation_id = $5,
          active_interaction_id = $6,
          last_session_id = COALESCE($7, last_session_id),
          last_activity_at = NOW(),
          last_run_started_at = CASE
            WHEN $3::remote_agent_bindings_runtime_state IN (
              'running',
              'waiting_user_input',
              'plan_drafting',
              'waiting_plan_approval'
            )
              THEN COALESCE(last_run_started_at, NOW())
            ELSE last_run_started_at
          END,
          last_run_finished_at = CASE
            WHEN $3::remote_agent_bindings_runtime_state IN ('idle', 'error', 'offline')
              THEN NOW()
            ELSE last_run_finished_at
          END,
          last_error = $8,
          capabilities = CASE
            WHEN $9::jsonb IS NULL THEN capabilities
            ELSE COALESCE(capabilities, '{}'::jsonb) || $9::jsonb
          END,
          updated_at = NOW()
      WHERE remote_agent_id = $1
        AND machine_id = $2
    `,
    [
      message.remoteAgentId,
      machineId,
      message.state,
      message.statusText ?? null,
      message.conversationId ?? null,
      message.interactionId ?? null,
      message.sessionId ?? null,
      message.lastError ?? null,
      message.capabilities ? JSON.stringify(message.capabilities) : null,
    ]
  )

  if (runId && message.interactionId) {
    await executeSqlOn(
      queryable,
      `
        UPDATE remote_agent_runs
        SET interaction_id = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [runId, message.interactionId]
    )
  }

  await emitRemoteAgentRuntimeUpdated(message.remoteAgentId, queryable)
}

async function loadPendingRemoteAgentDeliveries(params: {
  machineId?: string
  conversationId?: string
  remoteAgentIds?: string[]
}) {
  const values: any[] = []
  const where: string[] = [
    "delivery.status = 'pending'",
    "binding.status = 'active'",
  ]

  if (params.machineId) {
    values.push(params.machineId)
    where.push(`binding.machine_id = $${values.length}`)
  }

  if (params.conversationId) {
    values.push(params.conversationId)
    where.push(`delivery.conversation_id = $${values.length}`)
  }

  if (params.remoteAgentIds && params.remoteAgentIds.length > 0) {
    values.push(params.remoteAgentIds)
    where.push(`delivery.remote_agent_id = ANY($${values.length}::uuid[])`)
  }

  return executeSql<{
    delivery_id: string
    remote_agent_id: string
    machine_id: string
    item_id: string
    conversation_id: string
  }>(
    `
      SELECT
        delivery.id AS delivery_id,
        delivery.remote_agent_id,
        binding.machine_id,
        delivery.item_id,
        delivery.conversation_id
      FROM remote_agent_message_deliveries delivery
      INNER JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = delivery.remote_agent_id
      WHERE ${where.join("\n        AND ")}
      ORDER BY delivery.created_at ASC
    `,
    values
  )
}

async function notifyPendingRemoteAgentDeliveries(params: {
  machineId?: string
  conversationId?: string
  remoteAgentIds?: string[]
}) {
  const result = await loadPendingRemoteAgentDeliveries(params)
  const grouped = new Map<
    string,
    Array<{
      remoteAgentId: string
      deliveryId: string
      conversationId: string
      itemId: string
    }>
  >()

  for (const row of result.rows) {
    const current = grouped.get(row.machine_id) ?? []
    current.push({
      remoteAgentId: row.remote_agent_id,
      deliveryId: row.delivery_id,
      conversationId: row.conversation_id,
      itemId: row.item_id,
    })
    grouped.set(row.machine_id, current)
  }

  for (const [machineId, deliveries] of grouped) {
    const connection = machineConnections.get(machineId)
    if (!connection) continue
    safeSend(connection, {
      type: "agent:deliver",
      deliveries,
    })
  }
}

function parseMachineKeyFromRequest(request: {
  headers: Record<string, unknown>
}) {
  const authorization =
    typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : ""
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim()
  }

  const header =
    typeof request.headers["x-synapse-machine-key"] === "string"
      ? request.headers["x-synapse-machine-key"].trim()
      : ""
  return header || ""
}

async function authenticateMachineForRemoteAgent(params: {
  remoteAgentId: string
  machineKey: string
}) {
  if (!params.machineKey) {
    throw new Error("Machine key is required")
  }
  const machine = await loadMachineByApiKey(params.machineKey)
  if (!machine || machine.trust_status !== "active") {
    throw new Error("Machine authentication failed")
  }

  const result = await executeSql<{
    remote_agent_id: string
    machine_id: string
    workspace_id: string
    local_root_path: string | null
  }>(
    `
      SELECT
        binding.remote_agent_id,
        binding.machine_id,
        agent.workspace_id,
        binding.local_root_path
      FROM remote_agent_bindings binding
      INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
      WHERE binding.remote_agent_id = $1
        AND binding.machine_id = $2
        AND binding.status = 'active'
        AND agent.is_active = TRUE
      LIMIT 1
    `,
    [params.remoteAgentId, machine.id]
  )

  const binding = result.rows[0]
  if (!binding) {
    throw new Error("Remote agent is not bound to this machine")
  }

  return {
    machineId: machine.id,
    workspaceId: binding.workspace_id,
    localRootPath: binding.local_root_path ?? undefined,
  }
}

async function loadConversationHostWorkspaceId(
  conversationId: string,
  queryable: Queryable = {
    query: (text, params) => executeSql(text, params),
  }
) {
  const result = await executeSqlOn<{ workspace_id: string | null }>(
    queryable,
    `
      SELECT internal_workspace_id AS workspace_id
      FROM conversations
      WHERE id = $1
      LIMIT 1
    `,
    [conversationId]
  )
  return result.rows[0]?.workspace_id ?? null
}

function mapRuntimeSummaryFromRow(row: {
  runtime_kind: RemoteAgentRuntimeKind
  runtime_state?: RemoteAgentRuntimeState | null
  status_text?: string | null
  last_session_id?: string | null
  active_conversation_id?: string | null
  active_interaction_id?: string | null
  last_activity_at?: string | Date | null
  last_run_started_at?: string | Date | null
  last_run_finished_at?: string | Date | null
  last_error?: string | null
  capabilities?: unknown
  pending_conversation_count?: string | number | null
  unread_delivery_count?: string | number | null
}) {
  return {
    runtimeKind: row.runtime_kind,
    state: row.runtime_state ?? "offline",
    statusText: row.status_text ?? undefined,
    sessionId: row.last_session_id ?? undefined,
    activeConversationId: row.active_conversation_id ?? undefined,
    activeInteractionId: row.active_interaction_id ?? undefined,
    pendingConversationCount: Number(row.pending_conversation_count ?? 0),
    unreadDeliveryCount: Number(row.unread_delivery_count ?? 0),
    lastActivityAt: toIso(row.last_activity_at),
    lastRunStartedAt: toIso(row.last_run_started_at),
    lastRunFinishedAt: toIso(row.last_run_finished_at),
    lastError: row.last_error ?? undefined,
    capabilities:
      row.capabilities && typeof row.capabilities === "object"
        ? (row.capabilities as RuntimeCapabilities)
        : {},
  }
}

async function ensureRemoteAgentRun(params: {
  remoteAgentId: string
  conversationId?: string | null
  runKey: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  statusText?: string | null
  lastError?: string | null
  queryable?: Queryable
}) {
  const queryable = params.queryable ?? {
    query: (text: string, values?: any[]) => executeSql(text, values),
  }
  const existing = await executeSqlOn<{ id: string }>(
    queryable,
    `
      SELECT id
      FROM remote_agent_runs
      WHERE run_key = $1
      LIMIT 1
    `,
    [params.runKey]
  )
  if (existing.rows[0]?.id) {
    await executeSqlOn(
      queryable,
      `
        UPDATE remote_agent_runs
        SET conversation_id = COALESCE($2, conversation_id),
            status = $3::remote_agent_runs_status,
            status_text = $4,
            last_error = $5,
            started_at = COALESCE(
              started_at,
              CASE WHEN $3::text = 'running' THEN NOW() ELSE NULL END
            ),
            ended_at = CASE
              WHEN $3::text IN ('completed', 'failed', 'cancelled') THEN NOW()
              ELSE NULL
            END,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        existing.rows[0].id,
        params.conversationId ?? null,
        params.status,
        params.statusText ?? null,
        params.lastError ?? null,
      ]
    )
    return existing.rows[0].id
  }

  const inserted = await executeSqlOn<{ id: string }>(
    queryable,
    `
      INSERT INTO remote_agent_runs (
        remote_agent_id,
        run_key,
        conversation_id,
        status,
        status_text,
        last_error,
        started_at,
        ended_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::remote_agent_runs_status,
        $5,
        $6,
        CASE WHEN $4::text = 'running' THEN NOW() ELSE NULL END,
        CASE
          WHEN $4::text IN ('completed', 'failed', 'cancelled') THEN NOW()
          ELSE NULL
        END,
        NOW(),
        NOW()
      )
      RETURNING id
    `,
    [
      params.remoteAgentId,
      params.runKey,
      params.conversationId ?? null,
      params.status,
      params.statusText ?? null,
      params.lastError ?? null,
    ]
  )
  return inserted.rows[0]!.id
}

export async function loadRemoteAgentRuntimeSnapshot(
  remoteAgentId: string,
  queryable: Queryable = {
    query: (text, params) => executeSql(text, params),
  }
) {
  const result = await executeSqlOn<{
    remote_agent_id: string
    runtime_kind: RemoteAgentRuntimeKind
    runtime_state: RemoteAgentRuntimeState
    status_text: string | null
    active_conversation_id: string | null
    active_interaction_id: string | null
    last_session_id: string | null
    last_activity_at: string | Date | null
    last_run_started_at: string | Date | null
    last_run_finished_at: string | Date | null
    last_error: string | null
    updated_at: string | Date
    pending_conversation_count: string | number
    unread_delivery_count: string | number
    capabilities: unknown
  }>(
    queryable,
    `
      SELECT
        binding.remote_agent_id,
        binding.runtime_kind,
        binding.runtime_state,
        binding.status_text,
        binding.active_conversation_id,
        binding.active_interaction_id,
        binding.last_session_id,
        binding.last_activity_at,
        binding.last_run_started_at,
        binding.last_run_finished_at,
        binding.last_error,
        binding.updated_at,
        COALESCE(
          (
            SELECT COUNT(DISTINCT delivery.conversation_id)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
          ),
          0
        ) AS pending_conversation_count,
        COALESCE(
          (
            SELECT COUNT(*)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
          ),
          0
        ) AS unread_delivery_count,
        binding.capabilities
      FROM remote_agent_bindings binding
      WHERE binding.remote_agent_id = $1
      LIMIT 1
    `,
    [remoteAgentId]
  )
  const row = result.rows[0]
  if (!row) {
    return null
  }
  const updatedAt = toIso(row.updated_at) ?? new Date().toISOString()
  const lastErrorAt = toIso(row.last_activity_at) || toIso(row.updated_at)
  return {
    remoteAgentId: row.remote_agent_id,
    runtimeKind: row.runtime_kind,
    state: row.runtime_state,
    statusText: row.status_text ?? undefined,
    activeConversationId: row.active_conversation_id ?? undefined,
    activeInteractionId: row.active_interaction_id ?? undefined,
    sessionId: row.last_session_id ?? undefined,
    pendingConversationCount: Number(row.pending_conversation_count ?? 0),
    unreadDeliveryCount: Number(row.unread_delivery_count ?? 0),
    lastActivityAt: toIso(row.last_activity_at),
    lastRunStartedAt: toIso(row.last_run_started_at),
    lastRunFinishedAt: toIso(row.last_run_finished_at),
    lastError:
      row.last_error && lastErrorAt
        ? {
            message: row.last_error,
            at: lastErrorAt,
          }
        : undefined,
    updatedAt,
    capabilities:
      row.capabilities && typeof row.capabilities === "object"
        ? (row.capabilities as RuntimeCapabilities)
        : {},
  }
}

async function emitRemoteAgentRuntimeUpdated(
  remoteAgentId: string,
  queryable: Queryable = {
    query: (text, params) => executeSql(text, params),
  }
) {
  const snapshot = await loadRemoteAgentRuntimeSnapshot(
    remoteAgentId,
    queryable
  )
  if (!snapshot) {
    return null
  }
  const recipients = await executeSqlOn<{
    workspace_id: string
    workspace_member_id: string
  }>(
    queryable,
    `
      SELECT DISTINCT member.workspace_id, viewer.workspace_member_id
      FROM conversation_participants agent_cp
      INNER JOIN conversation_participants viewer
        ON viewer.conversation_id = agent_cp.conversation_id
       AND viewer.state = 'active'
       AND viewer.workspace_member_id IS NOT NULL
      INNER JOIN workspace_members member
        ON member.id = viewer.workspace_member_id
      WHERE agent_cp.remote_agent_id = $1
        AND agent_cp.state = 'active'
    `,
    [remoteAgentId]
  )
  const { appendWorkspaceMemberSyncEvent } = await import("../chat/service.js")
  for (const recipient of recipients.rows) {
    await appendWorkspaceMemberSyncEvent(queryable, {
      workspaceId: recipient.workspace_id,
      workspaceMemberId: recipient.workspace_member_id,
      eventType: "remote_agent.runtime_updated",
      payload: {
        remoteAgentId,
        snapshot,
      },
    })
  }
  return snapshot
}

async function mapRemoteAgentRow(row: {
  id: string
  workspace_id: string
  name: string
  title: string
  description: string | null
  runtime_kind: RemoteAgentRuntimeKind
  avatar_file_id: string | null
  avatar_emoji: string | null
  access_policy: RemoteAgentAccessPolicy
  is_active: boolean
  is_public_shared: boolean
  metadata: unknown
  created_by_workspace_member_id: string | null
  created_at: string | Date
  updated_at: string | Date
  machine_id?: string | null
  machine_title?: string | null
  binding_status?: string | null
  runtime_path?: string | null
  local_root_path?: string | null
  machine_lifecycle_state?: string | null
  runtime_state?: RemoteAgentRuntimeState | null
  status_text?: string | null
  last_session_id?: string | null
  active_conversation_id?: string | null
  active_interaction_id?: string | null
  last_activity_at?: string | Date | null
  last_run_started_at?: string | Date | null
  last_run_finished_at?: string | Date | null
  last_error?: string | null
  capabilities?: unknown
  pending_conversation_count?: string | number | null
  unread_delivery_count?: string | number | null
}) {
  const runtimeSummary = row.machine_id
    ? mapRuntimeSummaryFromRow(row)
    : undefined
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    title: row.title,
    description: row.description ?? undefined,
    runtimeKind: row.runtime_kind,
    avatarFileId: row.avatar_file_id ?? undefined,
    avatarEmoji: row.avatar_emoji ?? undefined,
    accessPolicy: row.access_policy,
    isActive: row.is_active,
    isPublicShared: row.is_public_shared,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdByWorkspaceMemberId: row.created_by_workspace_member_id ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
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

export async function listRemoteAgents(params: {
  workspaceId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const result = await executeSql<any>(
    `
      SELECT
        agent.*,
        binding.machine_id,
        machine.title AS machine_title,
        binding.status AS binding_status,
        binding.runtime_path,
        binding.local_root_path,
        machine.lifecycle_state AS machine_lifecycle_state,
        binding.runtime_state,
        binding.status_text,
        binding.last_session_id,
        binding.active_conversation_id,
        binding.active_interaction_id,
        binding.last_activity_at,
        binding.last_run_started_at,
        binding.last_run_finished_at,
        binding.last_error,
        binding.capabilities,
        (
          SELECT COUNT(DISTINCT delivery.conversation_id)
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = agent.id
            AND delivery.status = 'pending'
        ) AS pending_conversation_count,
        (
          SELECT COUNT(*)
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = agent.id
            AND delivery.status = 'pending'
        ) AS unread_delivery_count
      FROM remote_agents agent
      LEFT JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = agent.id
      LEFT JOIN remote_agent_machines machine
        ON machine.id = binding.machine_id
      WHERE agent.workspace_id = $1
      ORDER BY agent.created_at DESC, agent.id DESC
    `,
    [params.workspaceId]
  )
  return {
    remoteAgents: await Promise.all(result.rows.map(mapRemoteAgentRow)),
  }
}

export async function getRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const result = await executeSql<any>(
    `
      SELECT
        agent.*,
        binding.machine_id,
        machine.title AS machine_title,
        binding.status AS binding_status,
        binding.runtime_path,
        binding.local_root_path,
        machine.lifecycle_state AS machine_lifecycle_state,
        binding.runtime_state,
        binding.status_text,
        binding.last_session_id,
        binding.active_conversation_id,
        binding.active_interaction_id,
        binding.last_activity_at,
        binding.last_run_started_at,
        binding.last_run_finished_at,
        binding.last_error,
        binding.capabilities,
        (
          SELECT COUNT(DISTINCT delivery.conversation_id)
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = agent.id
            AND delivery.status = 'pending'
        ) AS pending_conversation_count,
        (
          SELECT COUNT(*)
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = agent.id
            AND delivery.status = 'pending'
        ) AS unread_delivery_count
      FROM remote_agents agent
      LEFT JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = agent.id
      LEFT JOIN remote_agent_machines machine
        ON machine.id = binding.machine_id
      WHERE agent.workspace_id = $1
        AND agent.id = $2
      LIMIT 1
    `,
    [params.workspaceId, params.remoteAgentId]
  )
  const row = result.rows[0]
  if (!row) {
    throw new Error("Remote agent not found")
  }
  return {
    remoteAgent: await mapRemoteAgentRow(row),
  }
}

export async function createRemoteAgent(params: {
  workspaceId: string
  userId: string
  name: string
  title: string
  description?: string
  runtimeKind: RemoteAgentRuntimeKind
  avatarFileId?: string
  avatarEmoji?: string
  accessPolicy?: RemoteAgentAccessPolicy
  isPublicShared?: boolean
  metadata?: Record<string, unknown>
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const result = await executeSql<any>(
    `
      INSERT INTO remote_agents (
        workspace_id,
        name,
        title,
        description,
        runtime_kind,
        avatar_file_id,
        avatar_emoji,
        access_policy,
        is_public_shared,
        metadata,
        created_by_workspace_member_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NOW(), NOW())
      RETURNING *
    `,
    [
      params.workspaceId,
      params.name.trim(),
      params.title.trim(),
      params.description?.trim() || null,
      params.runtimeKind,
      params.avatarFileId ?? null,
      params.avatarEmoji ?? null,
      params.accessPolicy ?? "workspace_open",
      params.isPublicShared === true,
      JSON.stringify(params.metadata ?? {}),
      identity.workspaceMemberId,
    ]
  )
  return {
    remoteAgent: await mapRemoteAgentRow(result.rows[0]!),
  }
}

export async function updateRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
  name?: string
  title?: string
  description?: string | null
  avatarFileId?: string | null
  avatarEmoji?: string | null
  accessPolicy?: RemoteAgentAccessPolicy
  isPublicShared?: boolean
  isActive?: boolean
  metadata?: Record<string, unknown>
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const existing = await getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })

  const nextMetadata = {
    ...(existing.remoteAgent.metadata ?? {}),
    ...(params.metadata ?? {}),
  }

  const result = await executeSql<any>(
    `
      UPDATE remote_agents
      SET name = $3,
          title = $4,
          description = $5,
          avatar_file_id = $6,
          avatar_emoji = $7,
          access_policy = $8,
          is_public_shared = $9,
          is_active = $10,
          metadata = $11::jsonb,
          updated_at = NOW()
      WHERE workspace_id = $1
        AND id = $2
      RETURNING *
    `,
    [
      params.workspaceId,
      params.remoteAgentId,
      params.name?.trim() || existing.remoteAgent.name,
      params.title?.trim() || existing.remoteAgent.title,
      params.description === undefined
        ? (existing.remoteAgent.description ?? null)
        : params.description,
      params.avatarFileId === undefined
        ? (existing.remoteAgent.avatarFileId ?? null)
        : params.avatarFileId,
      params.avatarEmoji === undefined
        ? (existing.remoteAgent.avatarEmoji ?? null)
        : params.avatarEmoji,
      params.accessPolicy ?? existing.remoteAgent.accessPolicy,
      params.isPublicShared ?? existing.remoteAgent.isPublicShared,
      params.isActive ?? existing.remoteAgent.isActive,
      JSON.stringify(nextMetadata),
    ]
  )
  return {
    remoteAgent: await mapRemoteAgentRow(result.rows[0]!),
  }
}

export async function deleteRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  await executeSql(
    `
      DELETE FROM remote_agents
      WHERE workspace_id = $1
        AND id = $2
    `,
    [params.workspaceId, params.remoteAgentId]
  )
  return { deleted: true }
}

export async function createRemoteAgentMachinePairingSession(params: {
  workspaceId: string
  userId: string
  title?: string
  description?: string
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const apiKey = `sk_machine_${randomBytes(24).toString("hex")}`
  const result = await executeSql<any>(
    `
      INSERT INTO remote_agent_machines (
        workspace_id,
        title,
        description,
        api_key_hash,
        trust_status,
        created_by_workspace_member_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'active', $5, NOW(), NOW())
      RETURNING *
    `,
    [
      params.workspaceId,
      params.title?.trim() || "Remote Agent Machine",
      params.description?.trim() || null,
      hashMachineApiKey(apiKey),
      identity.workspaceMemberId,
    ]
  )

  return {
    machine: {
      id: result.rows[0]!.id,
      workspaceId: result.rows[0]!.workspace_id,
      title: result.rows[0]!.title,
      description: result.rows[0]!.description ?? undefined,
      trustStatus: result.rows[0]!.trust_status,
      lifecycleState: result.rows[0]!.lifecycle_state ?? undefined,
      lastSeenAt: toIso(result.rows[0]!.last_seen_at),
      createdAt: toIso(result.rows[0]!.created_at),
      updatedAt: toIso(result.rows[0]!.updated_at),
    },
    apiKey,
    daemonCommand: buildDaemonCommand(apiKey),
  }
}

export async function listRemoteAgentMachines(params: {
  workspaceId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const result = await executeSql<any>(
    `
      SELECT
        machine.*,
        (
          SELECT COUNT(*)
          FROM remote_agent_bindings binding
          WHERE binding.machine_id = machine.id
            AND binding.status = 'active'
        ) AS binding_count
      FROM remote_agent_machines machine
      WHERE machine.workspace_id = $1
      ORDER BY machine.created_at DESC
    `,
    [params.workspaceId]
  )
  return {
    machines: result.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      description: row.description ?? undefined,
      trustStatus: row.trust_status,
      lifecycleState: row.lifecycle_state ?? undefined,
      bindingCount: Number(row.binding_count ?? 0),
      lastSeenAt: toIso(row.last_seen_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    })),
  }
}

export async function getRemoteAgentMachine(params: {
  workspaceId: string
  machineId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const [machineResult, catalogResult, bindingResult] = await Promise.all([
    executeSql<any>(
      `
        SELECT *
        FROM remote_agent_machines
        WHERE workspace_id = $1
          AND id = $2
        LIMIT 1
      `,
      [params.workspaceId, params.machineId]
    ),
    executeSql<any>(
      `
        SELECT *
        FROM remote_agent_runtime_catalog
        WHERE machine_id = $1
        ORDER BY runtime_kind ASC
      `,
      [params.machineId]
    ),
    executeSql<any>(
      `
        SELECT
          binding.remote_agent_id,
          binding.runtime_kind,
          binding.runtime_path,
          binding.local_root_path,
          binding.status,
          binding.runtime_state,
          binding.status_text,
          binding.last_session_id,
          binding.active_conversation_id,
          binding.active_interaction_id,
          binding.last_activity_at,
          binding.last_run_started_at,
          binding.last_run_finished_at,
          binding.last_error,
          binding.capabilities,
          agent.name,
          (
            SELECT COUNT(DISTINCT delivery.conversation_id)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
          ) AS pending_conversation_count,
          (
            SELECT COUNT(*)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
          ) AS unread_delivery_count
        FROM remote_agent_bindings binding
        INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
        WHERE binding.machine_id = $1
        ORDER BY agent.created_at DESC
      `,
      [params.machineId]
    ),
  ])

  const machine = machineResult.rows[0]
  if (!machine) {
    throw new Error("Machine not found")
  }

  return {
    machine: {
      id: machine.id,
      workspaceId: machine.workspace_id,
      title: machine.title,
      description: machine.description ?? undefined,
      trustStatus: machine.trust_status,
      lifecycleState: machine.lifecycle_state ?? undefined,
      lastSeenAt: toIso(machine.last_seen_at),
      createdAt: toIso(machine.created_at),
      updatedAt: toIso(machine.updated_at),
    },
    runtimeCatalog: catalogResult.rows.map((row) => ({
      runtimeKind: row.runtime_kind,
      executablePath: row.executable_path ?? undefined,
      status: row.status,
      version: row.version ?? undefined,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {},
      lastError: row.last_error ?? undefined,
      lastSeenAt: toIso(row.last_seen_at),
    })),
    bindings: bindingResult.rows.map((row) => ({
      remoteAgentId: row.remote_agent_id,
      name: row.name,
      runtimeKind: row.runtime_kind,
      runtimePath: row.runtime_path ?? undefined,
      localRootPath: row.local_root_path ?? undefined,
      status: row.status,
      runtimeSummary: mapRuntimeSummaryFromRow(row),
    })),
  }
}

export async function bindRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
  machineId: string
  runtimeKind: RemoteAgentRuntimeKind
  runtimePath?: string
  localRootPath?: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const existing = await getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
  if (!existing.remoteAgent.isActive) {
    throw new Error("Remote agent is inactive")
  }
  if (existing.remoteAgent.runtimeKind !== params.runtimeKind) {
    throw new Error("Binding runtime kind must match remote agent runtime kind")
  }

  const machineResult = await executeSql<{ id: string }>(
    `
      SELECT id
      FROM remote_agent_machines
      WHERE workspace_id = $1
        AND id = $2
      LIMIT 1
    `,
    [params.workspaceId, params.machineId]
  )
  if (!machineResult.rows[0]) {
    throw new Error("Machine not found")
  }

  const catalogResult = await executeSql<{
    executable_path: string | null
    status:
      | "available"
      | "missing_binary"
      | "broken_path"
      | "unsupported_platform"
      | "runtime_error"
    last_error: string | null
  }>(
    `
      SELECT executable_path, status, last_error
      FROM remote_agent_runtime_catalog
      WHERE machine_id = $1
        AND runtime_kind = $2
      LIMIT 1
    `,
    [params.machineId, params.runtimeKind]
  )

  const catalogEntry = catalogResult.rows[0] ?? null
  if (!params.runtimePath) {
    if (!catalogEntry) {
      throw new Error("Machine has not reported runtime availability yet")
    }
    if (catalogEntry.status !== "available") {
      const detail = catalogEntry.last_error?.trim()
        ? `: ${catalogEntry.last_error.trim()}`
        : ""
      throw new Error(
        `Runtime ${params.runtimeKind} is not available on this machine (${catalogEntry.status})${detail}`
      )
    }
  }

  const effectiveRuntimePath =
    params.runtimePath ?? catalogEntry?.executable_path ?? null

  await executeSql(
    `
      INSERT INTO remote_agent_bindings (
        remote_agent_id,
        machine_id,
        runtime_kind,
        runtime_path,
        local_root_path,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
      ON CONFLICT (remote_agent_id) DO UPDATE
      SET machine_id = EXCLUDED.machine_id,
          runtime_kind = EXCLUDED.runtime_kind,
          runtime_path = EXCLUDED.runtime_path,
          local_root_path = EXCLUDED.local_root_path,
          status = 'active',
          updated_at = NOW()
    `,
    [
      params.remoteAgentId,
      params.machineId,
      params.runtimeKind,
      effectiveRuntimePath,
      params.localRootPath ?? null,
    ]
  )

  await startBoundRemoteAgents(params.machineId)
  return getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
}

export async function listRemoteAgentGroupInteractionGrants(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  await getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
  const result = await executeSql<{
    workspace_member_id: string
    granted_by_workspace_member_id: string | null
    created_at: string | Date
    updated_at: string | Date
    user_id: string
    user_name: string | null
    user_avatar_file_id: string | null
  }>(
    `
      SELECT
        grant_row.workspace_member_id,
        grant_row.granted_by_workspace_member_id,
        grant_row.created_at,
        grant_row.updated_at,
        wm.user_id,
        u.name AS user_name,
        u.avatar_file_id AS user_avatar_file_id
      FROM remote_agent_group_interaction_grants grant_row
      INNER JOIN workspace_members wm ON wm.id = grant_row.workspace_member_id
      INNER JOIN users u ON u.id = wm.user_id
      WHERE grant_row.remote_agent_id = $1
      ORDER BY grant_row.created_at ASC
    `,
    [params.remoteAgentId]
  )
  return {
    grants: result.rows.map((row) => ({
      workspaceMemberId: row.workspace_member_id,
      grantedByWorkspaceMemberId:
        row.granted_by_workspace_member_id ?? undefined,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      userId: row.user_id,
      name: row.user_name ?? "Unknown user",
      avatarUrl: row.user_avatar_file_id
        ? getFileUrlById(row.user_avatar_file_id)
        : undefined,
    })),
  }
}

export async function updateRemoteAgentGroupInteractionGrants(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
  workspaceMemberIds: string[]
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  await getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
  const nextIds = [...new Set(params.workspaceMemberIds.filter(Boolean))]
  if (nextIds.length > 0) {
    const membership = await executeSql<{ id: string }>(
      `
        SELECT id
        FROM workspace_members
        WHERE workspace_id = $1
          AND id = ANY($2::uuid[])
      `,
      [params.workspaceId, nextIds]
    )
    if (membership.rows.length !== nextIds.length) {
      throw new Error("Some workspace members are invalid")
    }
  }

  await transaction(async (client) => {
    await executeSqlOn(
      client,
      `
        DELETE FROM remote_agent_group_interaction_grants
        WHERE remote_agent_id = $1
      `,
      [params.remoteAgentId]
    )
    for (const workspaceMemberId of nextIds) {
      await executeSqlOn(
        client,
        `
          INSERT INTO remote_agent_group_interaction_grants (
            remote_agent_id,
            workspace_member_id,
            granted_by_workspace_member_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, NOW(), NOW())
        `,
        [params.remoteAgentId, workspaceMemberId, identity.workspaceMemberId]
      )
    }
  })

  return listRemoteAgentGroupInteractionGrants(params)
}

export async function createRemoteAgentUserInputInteraction(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  runKey: string
  title: string
  instructions?: string
  questions: Array<Record<string, unknown>>
  expiresAt?: string
}) {
  const access = await authenticateMachineForRemoteAgent(params)
  const conversationAccess = await requireRemoteAgentConversationAccess(
    {
      query: (text: string, values?: any[]) => executeSql(text, values),
    },
    params.conversationId,
    params.remoteAgentId
  )
  const runId = await ensureRemoteAgentRun({
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    runKey: params.runKey,
    status: "running",
    statusText: "Waiting for user input",
  })
  const { createRemoteAgentUserInputInteractionRequest } =
    await import("../interactions/service.js")
  const interaction = await createRemoteAgentUserInputInteractionRequest({
    workspaceId: access.workspaceId,
    conversationId: params.conversationId,
    remoteAgentRunId: runId,
    requesterParticipantId: conversationAccess.participant.id,
    title: params.title,
    instructions: params.instructions,
    questions: params.questions as any[],
    expiresAt: params.expiresAt,
  })
  await updateRemoteAgentRuntimeStatus(access.machineId, {
    type: "agent:status",
    remoteAgentId: params.remoteAgentId,
    state: "waiting_user_input",
    statusText: params.title,
    conversationId: params.conversationId,
    interactionId: interaction.id,
    runKey: params.runKey,
  })
  return { interaction }
}

export async function createRemoteAgentPlanApprovalInteraction(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  runKey: string
  title: string
  summary?: string
  planMarkdown: string
  checklist?: Array<Record<string, unknown>>
  collaborationMode?: string
  collaborationState?: Record<string, unknown>
  expiresAt?: string
}) {
  const access = await authenticateMachineForRemoteAgent(params)
  const conversationAccess = await requireRemoteAgentConversationAccess(
    {
      query: (text: string, values?: any[]) => executeSql(text, values),
    },
    params.conversationId,
    params.remoteAgentId
  )
  const runId = await ensureRemoteAgentRun({
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    runKey: params.runKey,
    status: "running",
    statusText: "Waiting for plan approval",
  })
  const { createRemoteAgentPlanApprovalInteractionRequest } =
    await import("../interactions/service.js")
  const interaction = await createRemoteAgentPlanApprovalInteractionRequest({
    workspaceId: access.workspaceId,
    conversationId: params.conversationId,
    remoteAgentRunId: runId,
    requesterParticipantId: conversationAccess.participant.id,
    title: params.title,
    summary: params.summary,
    planMarkdown: params.planMarkdown,
    checklist: params.checklist as any[],
    collaborationMode: params.collaborationMode,
    collaborationState: params.collaborationState,
    expiresAt: params.expiresAt,
  })
  await updateRemoteAgentRuntimeStatus(access.machineId, {
    type: "agent:status",
    remoteAgentId: params.remoteAgentId,
    state: "waiting_plan_approval",
    statusText: params.title,
    conversationId: params.conversationId,
    interactionId: interaction.id,
    runKey: params.runKey,
  })
  return { interaction }
}

export async function createRemoteAgentDeliveriesForItem(params: {
  workspaceId?: string
  conversationId: string
  itemId: string
  authorParticipantId?: string
  queryable?: Queryable
}) {
  const queryable = params.queryable ?? {
    query: (text: string, values?: any[]) => executeSql(text, values),
  }
  const participants = await executeSqlOn<{
    participant_id: string
    remote_agent_id: string
  }>(
    queryable,
    `
      SELECT
        cp.id AS participant_id,
        cp.remote_agent_id
      FROM conversation_participants cp
      WHERE cp.conversation_id = $1
        AND cp.state = 'active'
        AND cp.remote_agent_id IS NOT NULL
        AND ($2::uuid IS NULL OR cp.id <> $2)
        AND (
          NOT EXISTS (
            SELECT 1
            FROM conversation_item_targets target0
            WHERE target0.item_id = $3
          )
          OR EXISTS (
            SELECT 1
            FROM conversation_item_targets target1
            WHERE target1.item_id = $3
              AND target1.target_participant_id = cp.id
          )
        )
    `,
    [params.conversationId, params.authorParticipantId ?? null, params.itemId]
  )

  for (const participant of participants.rows) {
    const inserted = await executeSqlOn(
      queryable,
      `
        INSERT INTO remote_agent_message_deliveries (
          remote_agent_id,
          conversation_id,
          item_id,
          status,
          attempts,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 'pending', 0, NOW(), NOW())
        ON CONFLICT (remote_agent_id, item_id) DO NOTHING
      `,
      [participant.remote_agent_id, params.conversationId, params.itemId]
    )

    if ((inserted.rowCount ?? 0) > 0) {
      await executeSqlOn(
        queryable,
        `
          INSERT INTO remote_agent_conversation_views (
            remote_agent_id,
            conversation_id,
            unread_count,
            last_delivery_item_id,
            last_delivery_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, 1, $3, NOW(), NOW(), NOW())
          ON CONFLICT (remote_agent_id, conversation_id) DO UPDATE
          SET unread_count = remote_agent_conversation_views.unread_count + 1,
              last_delivery_item_id = EXCLUDED.last_delivery_item_id,
              last_delivery_at = NOW(),
              updated_at = NOW()
        `,
        [participant.remote_agent_id, params.conversationId, params.itemId]
      )
    }
  }
}

export async function notifyRemoteAgentDeliveriesForConversation(
  conversationId: string
) {
  await notifyPendingRemoteAgentDeliveries({
    conversationId,
  })
}

export async function listRemoteAgentConversations(params: {
  remoteAgentId: string
  machineKey: string
}) {
  await authenticateMachineForRemoteAgent(params)
  const result = await executeSql<any>(
    `
      SELECT
        c.id,
        c.kind,
        c.boundary,
        c.title,
        c.updated_at,
        view.unread_count
      FROM conversation_participants cp
      INNER JOIN conversations c ON c.id = cp.conversation_id
      LEFT JOIN remote_agent_conversation_views view
        ON view.remote_agent_id = cp.remote_agent_id
       AND view.conversation_id = cp.conversation_id
      WHERE cp.remote_agent_id = $1
        AND cp.state = 'active'
      ORDER BY COALESCE(view.updated_at, c.updated_at, c.created_at) DESC, c.id ASC
    `,
    [params.remoteAgentId]
  )
  return {
    conversations: result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      boundary: row.boundary,
      title: row.title ?? undefined,
      unreadCount: Number(row.unread_count ?? 0),
      updatedAt: toIso(row.updated_at),
    })),
  }
}

export async function checkRemoteAgentMessages(params: {
  remoteAgentId: string
  machineKey: string
  limit?: number
}) {
  await authenticateMachineForRemoteAgent(params)
  const result = await executeSql<DeliveryRow>(
    `
      SELECT
        delivery.id,
        delivery.remote_agent_id,
        delivery.conversation_id,
        delivery.item_id,
        delivery.status,
        delivery.created_at,
        item.sequence
      FROM remote_agent_message_deliveries delivery
      INNER JOIN conversation_items item ON item.id = delivery.item_id
      WHERE delivery.remote_agent_id = $1
        AND delivery.status = 'pending'
      ORDER BY item.sequence ASC, delivery.created_at ASC
      LIMIT $2
    `,
    [params.remoteAgentId, Math.min(Math.max(params.limit ?? 100, 1), 500)]
  )

  return {
    deliveries: result.rows.map((row) => ({
      deliveryId: row.id,
      conversationId: row.conversation_id,
      itemId: row.item_id,
      sequence: Number(row.sequence),
      createdAt: toIso(row.created_at),
      status: row.status,
    })),
  }
}

export async function ackRemoteAgentDeliveries(params: {
  remoteAgentId: string
  machineKey: string
  deliveryIds: string[]
}) {
  await authenticateMachineForRemoteAgent(params)
  const uniqueIds = [...new Set(params.deliveryIds.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return { acked: 0 }
  }

  const rows = await executeSql<{
    id: string
    conversation_id: string
    item_id: string
    sequence: string | number
  }>(
    `
      SELECT
        delivery.id,
        delivery.conversation_id,
        delivery.item_id,
        item.sequence
      FROM remote_agent_message_deliveries delivery
      INNER JOIN conversation_items item ON item.id = delivery.item_id
      WHERE delivery.remote_agent_id = $1
        AND delivery.id = ANY($2::uuid[])
    `,
    [params.remoteAgentId, uniqueIds]
  )

  await executeSql(
    `
      UPDATE remote_agent_message_deliveries
      SET status = 'acked',
          last_acked_at = NOW(),
          updated_at = NOW()
      WHERE remote_agent_id = $1
        AND id = ANY($2::uuid[])
    `,
    [params.remoteAgentId, uniqueIds]
  )

  const byConversation = new Map<string, { sequence: number; itemId: string }>()
  for (const row of rows.rows) {
    const sequence = Number(row.sequence)
    const existing = byConversation.get(row.conversation_id)
    if (!existing || sequence > existing.sequence) {
      byConversation.set(row.conversation_id, {
        sequence,
        itemId: row.item_id,
      })
    }
  }

  for (const [conversationId, state] of byConversation) {
    await executeSql(
      `
        INSERT INTO remote_agent_conversation_views (
          remote_agent_id,
          conversation_id,
          last_read_item_id,
          last_read_sequence,
          last_read_at,
          unread_count,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW(), 0, NOW(), NOW())
        ON CONFLICT (remote_agent_id, conversation_id) DO UPDATE
        SET last_read_item_id = EXCLUDED.last_read_item_id,
            last_read_sequence = GREATEST(remote_agent_conversation_views.last_read_sequence, EXCLUDED.last_read_sequence),
            last_read_at = NOW(),
            unread_count = GREATEST(
              0,
              (
                SELECT COUNT(*)
                FROM remote_agent_message_deliveries pending
                WHERE pending.remote_agent_id = $1
                  AND pending.conversation_id = $2
                  AND pending.status = 'pending'
              )
            ),
            updated_at = NOW()
      `,
      [params.remoteAgentId, conversationId, state.itemId, state.sequence]
    )
  }

  return {
    acked: uniqueIds.length,
  }
}

export async function getRemoteAgentConversationHistory(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  afterSequence?: number
  beforeSequence?: number
  limit?: number
}) {
  await authenticateMachineForRemoteAgent(params)
  const access = await requireRemoteAgentConversationAccess(
    {
      query: (text: string, values?: any[]) => executeSql(text, values),
    },
    params.conversationId,
    params.remoteAgentId
  )

  const items = await listVisibleConversationItemsForParticipant({
    conversationId: params.conversationId,
    participantId: access.participant.id,
    afterSequence: params.afterSequence,
    beforeSequence: params.beforeSequence,
    limit: params.limit,
  })

  return {
    items,
  }
}

export async function sendRemoteAgentConversationMessage(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  clientMessageId?: string
  contentBlocks: any[]
  replyToItemId?: string
  metadata?: Record<string, unknown>
}) {
  await authenticateMachineForRemoteAgent(params)
  const item = await transaction(async (client) => {
    const access = await requireRemoteAgentConversationAccess(
      client,
      params.conversationId,
      params.remoteAgentId
    )
    const hostWorkspaceId = await loadConversationHostWorkspaceId(
      params.conversationId,
      client
    )
    return sendConversationMessageFromParticipant({
      workspaceId: hostWorkspaceId ?? undefined,
      conversationId: params.conversationId,
      senderParticipantId: access.participant.id,
      clientMessageId: params.clientMessageId ?? crypto.randomUUID(),
      role: "assistant",
      contentBlocks: params.contentBlocks as any[],
      replyToItemId: params.replyToItemId,
      metadata: params.metadata,
      queryable: client,
    })
  })

  await notifyRemoteAgentDeliveriesForConversation(params.conversationId)

  return {
    item,
  }
}

export async function searchRemoteAgentMessages(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  query: string
  limit?: number
}) {
  await authenticateMachineForRemoteAgent(params)
  const access = await requireRemoteAgentConversationAccess(
    {
      query: (text: string, values?: any[]) => executeSql(text, values),
    },
    params.conversationId,
    params.remoteAgentId
  )

  const result = await executeSql<{
    id: string
    sequence: string | number
  }>(
    `
      SELECT DISTINCT item.id, item.sequence
      FROM conversation_items item
      INNER JOIN conversation_item_parts part ON part.item_id = item.id
      WHERE item.conversation_id = $1
        AND item.scope = 'shared'
        AND item.surface = 'visible'
        AND part.part_type = 'text'
        AND part.text_value ILIKE $2
        AND (
          NOT EXISTS (
            SELECT 1
            FROM conversation_item_targets target0
            WHERE target0.item_id = item.id
          )
          OR item.author_participant_id = $3
          OR EXISTS (
            SELECT 1
            FROM conversation_item_targets target1
            WHERE target1.item_id = item.id
              AND target1.target_participant_id = $3
          )
        )
      ORDER BY item.sequence DESC
      LIMIT $4
    `,
    [
      params.conversationId,
      `%${params.query.trim()}%`,
      access.participant.id,
      Math.min(Math.max(params.limit ?? 20, 1), 100),
    ]
  )

  return {
    matches: result.rows.map((row) => ({
      itemId: row.id,
      sequence: Number(row.sequence),
    })),
  }
}

export async function notifyRemoteAgentInteractionResolved(
  interactionId: string
) {
  const { getInteractionRequestSummary } =
    await import("../interactions/service.js")
  const interaction = await getInteractionRequestSummary(interactionId)
  if (
    !interaction ||
    interaction.requester?.participantType !== "remote_agent" ||
    !interaction.requester.remoteAgentId
  ) {
    return false
  }

  const binding = await executeSql<{
    machine_id: string
  }>(
    `
      SELECT machine_id
      FROM remote_agent_bindings
      WHERE remote_agent_id = $1
        AND status = 'active'
      LIMIT 1
    `,
    [interaction.requester.remoteAgentId]
  )
  const machineId = binding.rows[0]?.machine_id
  if (!machineId) {
    return false
  }
  const connection = machineConnections.get(machineId)
  if (!connection) {
    return false
  }
  return safeSend(connection, {
    type: "agent:interaction:resolved",
    remoteAgentId: interaction.requester.remoteAgentId,
    interactionId,
    interaction,
  })
}

function closeMachineConnection(
  connection: MachineConnection,
  code = 1008,
  reason = "closing"
) {
  try {
    if (
      connection.socket.readyState === 0 ||
      connection.socket.readyState === 1
    ) {
      connection.socket.close(code, reason)
    }
  } catch {}
}

async function finalizeMachineSession(
  connection: MachineConnection,
  closeReason?: string
) {
  machineConnections.delete(connection.machineId)
  await executeSql(
    `
      UPDATE remote_agent_machine_sessions
      SET status = 'closed',
          close_reason = COALESCE($2, close_reason),
          ended_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [connection.sessionId, closeReason ?? null]
  )
  await setMachineLifecycleState(connection.machineId, "offline")
  const bindings = await loadBoundRemoteAgentsForMachine(connection.machineId)
  for (const binding of bindings) {
    await executeSql(
      `
        UPDATE remote_agent_bindings
        SET runtime_state = 'offline',
            status_text = $2,
            active_conversation_id = NULL,
            active_interaction_id = NULL,
            last_run_finished_at = NOW(),
            updated_at = NOW()
        WHERE remote_agent_id = $1
      `,
      [binding.remote_agent_id, closeReason ?? "Daemon disconnected"]
    )
    await emitRemoteAgentRuntimeUpdated(binding.remote_agent_id)
  }
}

export async function handleRemoteAgentDaemonConnection(
  socket: any,
  req: any,
  _app: FastifyInstance
) {
  const requestUrl = new URL(req.url, config.app.baseUrl)
  const apiKey = requestUrl.searchParams.get("key")?.trim() || ""
  const machine = await loadMachineByApiKey(apiKey)
  if (!machine || machine.trust_status !== "active") {
    try {
      socket.send(
        JSON.stringify({
          type: "auth_error",
          message: "Invalid machine key",
        })
      )
    } catch {}
    try {
      socket.close(1008, "invalid machine key")
    } catch {}
    return
  }

  const sessionResult = await executeSql<{ id: string }>(
    `
      INSERT INTO remote_agent_machine_sessions (
        machine_id,
        status,
        transport,
        remote_addr,
        last_heartbeat_at,
        started_at,
        created_at,
        updated_at
      )
      VALUES ($1, 'connecting', 'websocket', $2, NOW(), NOW(), NOW(), NOW())
      RETURNING id
    `,
    [machine.id, req.socket?.remoteAddress ?? null]
  )
  const sessionId = sessionResult.rows[0]!.id

  const connection: MachineConnection = {
    machineId: machine.id,
    workspaceId: machine.workspace_id,
    sessionId,
    socket,
    ready: false,
  }
  machineConnections.set(machine.id, connection)
  await setMachineLifecycleState(machine.id, "online")

  try {
    socket.send(
      JSON.stringify({
        type: "connected",
        machineId: machine.id,
        sessionId,
      })
    )
  } catch {}

  socket.on("message", async (raw: any) => {
    let message: any
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }

    if (message?.type === "heartbeat") {
      await executeSql(
        `
          UPDATE remote_agent_machine_sessions
          SET last_heartbeat_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [sessionId]
      )
      try {
        socket.send(JSON.stringify({ type: "pong" }))
      } catch {}
      return
    }

    if (message?.type === "ready") {
      connection.ready = true
      await executeSql(
        `
          UPDATE remote_agent_machine_sessions
          SET status = 'active',
              last_heartbeat_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [sessionId]
      )
      if (Array.isArray(message.runtimeCatalog)) {
        await upsertRuntimeCatalog(machine.id, message.runtimeCatalog)
      }
      await startBoundRemoteAgents(machine.id)
      return
    }

    if (message?.type === "runtime:catalog" && Array.isArray(message.catalog)) {
      await upsertRuntimeCatalog(machine.id, message.catalog)
      return
    }

    if (
      message?.type === "agent:deliver:ack" &&
      Array.isArray(message.deliveryIds)
    ) {
      await ackRemoteAgentDeliveries({
        remoteAgentId: String(message.remoteAgentId || ""),
        machineKey: apiKey,
        deliveryIds: message.deliveryIds.filter(
          (value: unknown): value is string => typeof value === "string"
        ),
      })
      return
    }

    if (
      message?.type === "agent:session" &&
      typeof message.remoteAgentId === "string"
    ) {
      await executeSql(
        `
          UPDATE remote_agent_bindings
          SET last_session_id = $2,
              last_activity_at = NOW(),
              updated_at = NOW()
          WHERE remote_agent_id = $1
        `,
        [
          message.remoteAgentId,
          typeof message.sessionId === "string" ? message.sessionId : null,
        ]
      )
      await emitRemoteAgentRuntimeUpdated(message.remoteAgentId)
      return
    }

    if (
      message?.type === "agent:status" &&
      typeof message.remoteAgentId === "string"
    ) {
      await updateRemoteAgentRuntimeStatus(
        machine.id,
        message as RuntimeStatusMessage
      )
      return
    }
  })

  socket.on("close", async (_code: number, reason: Buffer) => {
    await finalizeMachineSession(
      connection,
      reason?.toString("utf8") || undefined
    )
  })

  socket.on("error", async (error: Error) => {
    await finalizeMachineSession(connection, error.message)
    closeMachineConnection(connection, 1011, error.message || "machine error")
  })
}

export function getMachineKeyFromHeaders(request: {
  headers: Record<string, unknown>
}) {
  return parseMachineKeyFromRequest(request)
}
