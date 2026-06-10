import crypto, { createHash, randomBytes } from "node:crypto"
import type { FastifyInstance } from "fastify"
import {
  REMOTE_AGENT_MACHINE_LIFECYCLE_STATE,
  REMOTE_AGENT_MACHINE_TRUST_STATUS,
  REMOTE_AGENT_RUNTIME_CATALOG_STATUS,
  REMOTE_AGENT_RUNTIME_STATE,
  type CapabilityAccessTarget,
  type RemoteAgentLifecycleState,
  type RemoteAgentMachineDetailView,
  type RemoteAgentMachinePairingSessionView,
  type OneClickInstallCommands,
  type RemoteAgentMachineTrustStatus,
  type RemoteAgentMachineView,
  type RemoteAgentRuntimeCapabilityView,
  type RemoteAgentRuntimeCatalogEntryView,
  type RemoteAgentRuntimeKind,
  type RemoteAgentRuntimeStateType,
  type RemoteAgentRuntimeSummaryView,
  type RemoteAgentRuntimeState,
  type RemoteAgentView,
  type WorkspaceAppGrantPermission,
  type Timestamp,
} from "@synapse/shared"
import { config } from "../../config/index.js"
import { buildDaemonCommand as buildDaemonCommandImpl } from "./daemon-command.js"
import {
  buildDaemonInstallCommands,
  getRenderedInstallerArtifacts,
} from "../installer/install-command.js"
import { CompiledQuery, sql } from "kysely"
import {
  db,
  runBuilder,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import {
  requireInstantDate,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import {
  authorizeAction,
  listAuthorizedResourceIds,
} from "../access/service.js"
import { deriveRequiresContactApproval } from "../access/contact-approval.js"
import {
  insertWorkspaceAppRoot,
  updateWorkspaceAppRoot,
} from "../workspace-apps/root-storage.js"
import { insertWorkspaceAppGrant } from "../workspace-apps/grant-storage.js"
import {
  getConversationParticipant,
  listVisibleConversationItemsForParticipant,
  requireRemoteAgentConversationAccess,
  sendConversationMessageFromParticipant,
} from "../chat/service.js"
import { getFileUrlById } from "../files/service.js"
import { requireWorkspaceMemberIdentity } from "../chat/workspace-identity.js"
import { nextAttemptAt, shouldFailDelivery } from "./delivery-retry.js"

/** Run raw SQL (text+params) on db / trx. */
async function runOn<T extends object = Record<string, unknown>>(
  executor: Executor,
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  const result = await executor.executeQuery<T>(
    CompiledQuery.raw(text, [...params])
  )
  return {
    rows: result.rows as T[],
    rowCount: Number(
      (result as { numAffectedRows?: bigint }).numAffectedRows ??
        result.rows.length
    ),
  }
}

/** `runOn` bound to the top-level db. */
function runOnDb<T extends object = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return runOn<T>(db, text, params)
}

type RuntimeCapabilities = RemoteAgentRuntimeCapabilityView

type MachineConnection = {
  machineId: string
  workspaceId: string
  sessionId: string
  fencingToken: string
  socket: any
  ready: boolean
}

type RuntimeCatalogEntry = {
  runtimeKind: RemoteAgentRuntimeKind
  executablePath?: string
  status: (typeof REMOTE_AGENT_RUNTIME_CATALOG_STATUS)[keyof typeof REMOTE_AGENT_RUNTIME_CATALOG_STATUS]
  version?: string
  metadata?: Record<string, unknown>
  lastError?: string
}

type RuntimeStatusMessage = {
  type: "agent:status"
  remoteAgentId: string
  state: RemoteAgentRuntimeStateType
  statusText?: string
  conversationId?: string | null
  taskId?: string | null
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
  created_at: Date
  sequence: string | number
}

const machineConnections = new Map<string, MachineConnection>()
const deliveryInFlightByMachine = new Map<string, Map<string, number>>()
const DELIVERY_IN_FLIGHT_TTL_MS = 5_000

function hashMachineApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex")
}

function buildDaemonCommand(apiKey: string) {
  return buildDaemonCommandImpl({
    serverUrl: config.app.baseUrl,
    apiKey,
    npmRegistryUrl: config.remoteAgent.npmRegistryUrl,
  })
}

// One-click bootstrap commands for a host with no Node yet. null when no
// private registry is configured (bootstrap can't fetch @synapse/* without it).
function buildDaemonOneClick(apiKey: string): OneClickInstallCommands | null {
  const artifacts = getRenderedInstallerArtifacts({
    serverUrl: config.app.baseUrl,
    privateRegistry: config.remoteAgent.npmRegistryUrl,
  })
  if (!artifacts) return null
  return buildDaemonInstallCommands({
    serverUrl: config.app.baseUrl,
    apiKey,
    shaSh: artifacts.shaSh,
    shaPs1: artifacts.shaPs1,
  })
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

function pruneInFlightDeliveryMap(machineId: string, now = Date.now()) {
  const current = deliveryInFlightByMachine.get(machineId)
  if (!current) {
    return new Map<string, number>()
  }
  for (const [deliveryId, expiresAt] of current) {
    if (expiresAt <= now) {
      current.delete(deliveryId)
    }
  }
  if (current.size === 0) {
    deliveryInFlightByMachine.delete(machineId)
    return new Map<string, number>()
  }
  return current
}

function markInFlightDeliveries(
  machineId: string,
  deliveryIds: string[],
  now = Date.now()
) {
  if (deliveryIds.length === 0) {
    return
  }
  const current = pruneInFlightDeliveryMap(machineId, now)
  for (const deliveryId of deliveryIds) {
    current.set(deliveryId, now + DELIVERY_IN_FLIGHT_TTL_MS)
  }
  if (current.size > 0) {
    deliveryInFlightByMachine.set(machineId, current)
  }
}

function clearInFlightDeliveries(machineId: string, deliveryIds: string[]) {
  if (deliveryIds.length === 0) {
    return
  }
  const current = deliveryInFlightByMachine.get(machineId)
  if (!current) {
    return
  }
  for (const deliveryId of deliveryIds) {
    current.delete(deliveryId)
  }
  if (current.size === 0) {
    deliveryInFlightByMachine.delete(machineId)
  }
}

async function loadMachineByApiKey(apiKey: string) {
  const result = await runBuilder(
    db,
    db
      .selectFrom("remoteAgentMachines")
      .select(["id", "workspaceId", "trustStatus"])
      .where("apiKeyHash", "=", hashMachineApiKey(apiKey))
      .limit(1)
  )
  return result.rows[0] ?? null
}

async function loadBoundRemoteAgentsForMachine(machineId: string) {
  const result = await runOnDb<{
    remote_agent_id: string
    runtime_kind: RemoteAgentRuntimeKind
    runtime_path: string | null
    local_root_path: string | null
  }>(
    `
      SELECT
        binding.remote_agent_id,
        binding.runtime_kind,
        binding.runtime_path,
        binding.local_root_path
      FROM remote_agent_bindings binding
      INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
      INNER JOIN workspace_apps_live app
        ON app.id = agent.id
      WHERE binding.machine_id = $1
        AND binding.status = 'active'
        AND app.deleted_at IS NULL
        AND app.status = 'active'
      ORDER BY agent.created_at ASC, agent.id ASC
    `,
    [machineId]
  )
  return result.rows
}

async function getOrInitConversationContext(
  remoteAgentId: string,
  conversationId: string,
  runtimeKind: RemoteAgentRuntimeKind | null,
  queryable: Executor = db
) {
  const result = await runBuilder(
    queryable,
    queryable
      .insertInto("remoteAgentConversationContexts")
      .values({
        remoteAgentId: remoteAgentId,
        conversationId: conversationId,
        runtimeKind: runtimeKind,
        createdAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(["remoteAgentId", "conversationId"]).doUpdateSet({
          runtimeKind: sql`COALESCE(remote_agent_conversation_contexts.runtime_kind, EXCLUDED.runtime_kind)`,
        })
      )
      .returning([
        "runtimeKind",
        "runtimeSessionId",
        "runtimeState",
        "statusText",
        "activeTaskId",
      ])
  )
  return result.rows[0] ?? null
}

async function updateConversationRuntimeStatus(
  params: {
    remoteAgentId: string
    conversationId: string
    runtimeKind?: RemoteAgentRuntimeKind | null
    state: RemoteAgentRuntimeStateType
    statusText?: string | null
    sessionId?: string | null
    taskId?: string | null
    lastError?: string | null
  },
  queryable: Executor = db
) {
  await runOn(
    queryable,
    `
      INSERT INTO remote_agent_conversation_contexts (
        remote_agent_id,
        conversation_id,
        runtime_kind,
        runtime_session_id,
        runtime_state,
        status_text,
        active_task_id,
        last_run_started_at,
        last_run_finished_at,
        last_activity_at,
        last_error,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2,
        $3,
        $4,
        $5::remote_agent_bindings_runtime_state,
        $6,
        $7,
        CASE
          WHEN $5::remote_agent_bindings_runtime_state IN (
            'running', 'waiting_user_input', 'plan_drafting', 'waiting_plan_approval'
          ) THEN NOW()
          ELSE NULL
        END,
        CASE
          WHEN $5::remote_agent_bindings_runtime_state IN ('idle', 'error', 'offline') THEN NOW()
          ELSE NULL
        END,
        NOW(),
        -- Honor the same NULL/empty/non-empty sentinel as the UPDATE arm
        -- below: an empty-string lastError on the very first status update
        -- for a conversation means "no prior error" and must land as NULL,
        -- not as an empty string. Without NULLIF the e2e final state would
        -- look clean today (no errors had been pushed) but the column type
        -- would silently shift to "string-or-empty-string-not-null" once a
        -- session_started arrived before any error event.
        NULLIF($8, ''),
        NOW(),
        NOW()
      )
      ON CONFLICT (remote_agent_id, conversation_id) DO UPDATE
      SET runtime_kind = COALESCE(EXCLUDED.runtime_kind, remote_agent_conversation_contexts.runtime_kind),
          runtime_session_id = COALESCE(EXCLUDED.runtime_session_id, remote_agent_conversation_contexts.runtime_session_id),
          runtime_state = EXCLUDED.runtime_state,
          status_text = EXCLUDED.status_text,
          active_task_id = EXCLUDED.active_task_id,
          last_run_started_at = CASE
            WHEN EXCLUDED.runtime_state IN (
              'running', 'waiting_user_input', 'plan_drafting', 'waiting_plan_approval'
            ) THEN COALESCE(remote_agent_conversation_contexts.last_run_started_at, NOW())
            ELSE remote_agent_conversation_contexts.last_run_started_at
          END,
          last_run_finished_at = CASE
            WHEN EXCLUDED.runtime_state IN ('idle', 'error', 'offline') THEN NOW()
            ELSE remote_agent_conversation_contexts.last_run_finished_at
          END,
          last_activity_at = NOW(),
          -- last_error semantics (mirrored in remote_agent_bindings below
          -- and remote_agent_runs further down):
          --   NULL          -> COALESCE preserves the prior value
          --   empty string  -> explicit clear (set to NULL)
          --   non-empty     -> set to the new message
          -- The daemon uses NULL when it has nothing to say about errors
          -- this update (plain idle/running ticks), empty string when a
          -- turn finished cleanly or a fresh session started (the "no
          -- alarm anymore" signal), and the message itself on error events.
          -- Before this scheme the unconditional assignment last_error =
          -- EXCLUDED.last_error caused the turn_completed -> idle update
          -- fired ~ms after an error to wipe the message; operators then
          -- saw idle + NULL even
          -- though the SDK had just blown up.
          last_error = CASE
            WHEN EXCLUDED.last_error IS NULL THEN remote_agent_conversation_contexts.last_error
            WHEN EXCLUDED.last_error = '' THEN NULL
            ELSE EXCLUDED.last_error
          END
    `,
    [
      params.remoteAgentId,
      params.conversationId,
      params.runtimeKind ?? null,
      params.sessionId ?? null,
      params.state,
      params.statusText ?? null,
      params.taskId ?? null,
      params.lastError ?? null,
    ]
  )
}

async function loadAgentStartTargetsForMachine(machineId: string) {
  // Only emit agent:start for (agent, conversation) pairs that have actual work
  // queued up. A daemon reconnect must never wake idle conversations whose
  // session id we happen to have on file — that's the "agent:start storm" the
  // refactor was meant to kill. Pending delivery is the only legitimate trigger
  // for waking a runtime; the per-conversation context's runtime_session_id is
  // passed along so the driver can resume in-place once it's waking.
  const result = await runOnDb<{
    remote_agent_id: string
    conversation_id: string
    runtime_kind: RemoteAgentRuntimeKind
    runtime_session_id: string | null
  }>(
    `
      SELECT
        binding.remote_agent_id,
        delivery.conversation_id,
        binding.runtime_kind,
        ctx.runtime_session_id
      FROM remote_agent_bindings binding
      INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
      INNER JOIN workspace_apps_live app
        ON app.id = agent.id
      INNER JOIN (
        SELECT DISTINCT remote_agent_id, conversation_id
        FROM remote_agent_message_deliveries
        WHERE status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ) delivery
        ON delivery.remote_agent_id = binding.remote_agent_id
      LEFT JOIN remote_agent_conversation_contexts ctx
        ON ctx.remote_agent_id = binding.remote_agent_id
        AND ctx.conversation_id = delivery.conversation_id
      WHERE binding.machine_id = $1
        AND binding.status = 'active'
        AND app.deleted_at IS NULL
        AND app.status = 'active'
      ORDER BY ctx.last_activity_at DESC NULLS LAST, delivery.conversation_id ASC
    `,
    [machineId]
  )
  return result.rows
}

async function setMachineLifecycleState(
  machineId: string,
  state: RemoteAgentLifecycleState,
  queryable: Executor = db
) {
  await queryable
    .updateTable("remoteAgentMachines")
    .set({
      lifecycleState: state,
      lastSeenAt: sql`NOW()`,
    })
    .where("id", "=", machineId)
    .execute()
}

async function upsertRuntimeCatalog(
  machineId: string,
  entries: RuntimeCatalogEntry[],
  queryable: Executor = db
) {
  for (const entry of entries) {
    await queryable
      .insertInto("remoteAgentRuntimeCatalog")
      .values({
        machineId: machineId,
        runtimeKind: entry.runtimeKind,
        executablePath: entry.executablePath ?? null,
        status: entry.status,
        version: entry.version ?? null,
        metadata: sql`${JSON.stringify(entry.metadata ?? {})}::jsonb`,
        lastSeenAt: sql`NOW()`,
        lastError: entry.lastError ?? null,
        createdAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(["machineId", "runtimeKind"]).doUpdateSet({
          executablePath: sql`EXCLUDED.executable_path`,
          status: sql`EXCLUDED.status`,
          version: sql`EXCLUDED.version`,
          metadata: sql`EXCLUDED.metadata`,
          lastSeenAt: sql`NOW()`,
          lastError: sql`EXCLUDED.last_error`,
        })
      )
      .execute()
  }
}

async function startBoundRemoteAgents(machineId: string) {
  const connection = machineConnections.get(machineId)
  if (!connection || !connection.ready) {
    return
  }

  const bindings = await loadBoundRemoteAgentsForMachine(machineId)
  if (bindings.length === 0) {
    return
  }
  const bindingByAgentId = new Map(
    bindings.map((row) => [row.remote_agent_id, row])
  )

  const targets = await loadAgentStartTargetsForMachine(machineId)

  for (const target of targets) {
    const binding = bindingByAgentId.get(target.remote_agent_id)
    if (!binding) continue
    safeSend(connection, {
      type: "agent:start",
      remoteAgentId: target.remote_agent_id,
      conversationId: target.conversation_id,
      runtimeKind: binding.runtime_kind,
      runtimePath: binding.runtime_path,
      localRootPath: binding.local_root_path,
      sessionId: target.runtime_session_id,
      fencingToken: connection.fencingToken,
      serverUrl: config.app.baseUrl,
    })
  }

  await notifyPendingRemoteAgentDeliveries({
    machineId,
    remoteAgentIds: bindings.map((binding) => binding.remote_agent_id),
  })
  await replayResolvedRemoteAgentTasks({
    machineId,
    remoteAgentIds: bindings.map((binding) => binding.remote_agent_id),
  })
}

async function replayResolvedRemoteAgentTasks(params: {
  machineId: string
  remoteAgentIds: string[]
}) {
  if (params.remoteAgentIds.length === 0) {
    return
  }
  const connection = machineConnections.get(params.machineId)
  if (!connection) {
    return
  }

  const rows = await runOnDb<{
    remote_agent_id: string
    active_task_id: string
    lifecycle_status: string
  }>(
    `
      SELECT
        ctx.remote_agent_id,
        ctx.active_task_id,
        task.lifecycle_status
      FROM remote_agent_conversation_contexts ctx
      INNER JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = ctx.remote_agent_id
      INNER JOIN tool_call_tasks task
        ON task.id = ctx.active_task_id
      WHERE binding.machine_id = $1
        AND ctx.remote_agent_id = ANY($2::uuid[])
        AND ctx.active_task_id IS NOT NULL
        AND task.lifecycle_status IN ('completed', 'failed', 'cancelled', 'expired')
    `,
    [params.machineId, params.remoteAgentIds]
  )

  if (rows.rows.length === 0) {
    return
  }

  const { getTaskSummary } = await import("../tasks/service.js")
  for (const row of rows.rows) {
    const task = await getTaskSummary(row.active_task_id)
    if (!task) {
      continue
    }
    safeSend(connection, {
      type: "agent:task:resolved",
      remoteAgentId: row.remote_agent_id,
      taskId: row.active_task_id,
      task,
    })
  }
}

async function updateRemoteAgentRuntimeStatus(
  machineId: string,
  message: RuntimeStatusMessage,
  queryable: Executor = db
) {
  const runStatus =
    message.state === REMOTE_AGENT_RUNTIME_STATE.OFFLINE
      ? "cancelled"
      : message.state === REMOTE_AGENT_RUNTIME_STATE.ERROR
        ? "failed"
        : message.state === REMOTE_AGENT_RUNTIME_STATE.IDLE
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

  if (message.conversationId) {
    const bindingRuntimeKind = await runBuilder(
      queryable,
      queryable
        .selectFrom("remoteAgentBindings")
        .select("runtimeKind")
        .where("remoteAgentId", "=", message.remoteAgentId)
        .where("machineId", "=", machineId)
        .limit(1)
    )
    await updateConversationRuntimeStatus(
      {
        remoteAgentId: message.remoteAgentId,
        conversationId: message.conversationId,
        runtimeKind: bindingRuntimeKind.rows[0]?.runtimeKind ?? null,
        state: message.state,
        statusText: message.statusText,
        sessionId: message.sessionId ?? null,
        taskId: message.taskId ?? null,
        lastError: message.lastError ?? null,
      },
      queryable
    )
  } else if (message.state === REMOTE_AGENT_RUNTIME_STATE.OFFLINE) {
    // Agent-wide stop (daemon sent state=offline without a conversationId,
    // typically from stopAll() during agent:stop handling). Propagate
    // offline to every per-conversation context so the binding aggregation
    // below resolves to offline instead of resurrecting whichever
    // running/idle state the contexts last reported. Without this,
    // "online stop" looks the same as "ignore the stop" on the UI.
    //
    // Disconnect tear-down is handled separately by the machine
    // finalizer (setMachineLifecycleState + the offline UPDATE down at
    // line ~2829), which still drives bindings to offline directly. This
    // branch covers the in-process stop where the daemon stays connected.
    await queryable
      .updateTable("remoteAgentConversationContexts")
      .set({
        runtimeState: "offline",
        statusText: message.statusText ?? null,
        lastActivityAt: sql`NOW()`,
        lastRunFinishedAt: sql`COALESCE(last_run_finished_at, NOW())`,
      })
      .where("remoteAgentId", "=", message.remoteAgentId)
      .where("runtimeState", "!=", "offline")
      .execute()
  }

  await runOn(
    queryable,
    `
      -- Aggregate binding fields from per-conversation contexts so the
      -- "machine overall" view doesn't oscillate as different conversations
      -- publish lifecycle ticks. Previously we wrote $3/$4/$5 directly,
      -- which meant a turn_completed -> idle from conversation A could
      -- overwrite a fresh running from conversation B (or vice versa), so
      -- the agent-overview page bounced between conversation states.
      --
      -- Aggregation rules (mirror LATEST_CONVERSATION_CONTEXT_LATERAL):
      --   runtime_state, status_text -> the "most active" context row
      --     (running/waiting > idle > error > offline, tiebreak by
      --     last_activity_at DESC). Falls back to 'offline' when no
      --     contexts exist.
      --   last_error -> the most recently active context that has a
      --     non-null error message; preserves any reported failure across
      --     idle updates from other conversations.
      --   last_activity_at -> MAX across contexts; never moves backwards
      --     even if a stale-activity update arrives from a quiet
      --     conversation.
      WITH ctxs AS (
        SELECT runtime_state, status_text, last_activity_at, last_error
        FROM remote_agent_conversation_contexts
        WHERE remote_agent_id = $1
      ),
      top_ctx AS (
        SELECT runtime_state, status_text, last_activity_at
        FROM ctxs
        ORDER BY
          CASE runtime_state
            WHEN 'running' THEN 0
            WHEN 'waiting_user_input' THEN 0
            WHEN 'plan_drafting' THEN 0
            WHEN 'waiting_plan_approval' THEN 0
            WHEN 'idle' THEN 1
            WHEN 'error' THEN 2
            ELSE 3
          END,
          last_activity_at DESC NULLS LAST
        LIMIT 1
      ),
      latest_error AS (
        SELECT last_error
        FROM ctxs
        WHERE last_error IS NOT NULL
        ORDER BY last_activity_at DESC NULLS LAST
        LIMIT 1
      )
      UPDATE remote_agent_bindings binding
      SET runtime_state = COALESCE(
            (SELECT runtime_state FROM top_ctx),
            'offline'::remote_agent_bindings_runtime_state
          ),
          status_text = (SELECT status_text FROM top_ctx),
          last_activity_at = GREATEST(
            COALESCE((SELECT last_activity_at FROM ctxs ORDER BY last_activity_at DESC NULLS LAST LIMIT 1), NOW()),
            binding.last_activity_at
          ),
          last_error = (SELECT last_error FROM latest_error),
          capabilities = CASE
            WHEN $3::jsonb IS NULL THEN binding.capabilities
            ELSE COALESCE(binding.capabilities, '{}'::jsonb) || $3::jsonb
          END
      WHERE binding.remote_agent_id = $1
        AND binding.machine_id = $2
    `,
    [
      message.remoteAgentId,
      machineId,
      message.capabilities ? JSON.stringify(message.capabilities) : null,
    ]
  )

  if (runId && message.taskId) {
    await queryable
      .updateTable("remoteAgentRuns")
      .set({
        taskId: message.taskId,
      })
      .where("id", "=", runId)
      .execute()
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
    "(delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= NOW())",
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

  return runOnDb<{
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

async function sendAgentStartPrefix(
  connection: MachineConnection,
  pendingForSend: Array<{ remoteAgentId: string; conversationId: string }>,
  machineId: string
) {
  const pairs = new Map<
    string,
    { remoteAgentId: string; conversationId: string }
  >()
  for (const delivery of pendingForSend) {
    const key = `${delivery.remoteAgentId}:${delivery.conversationId}`
    if (!pairs.has(key)) {
      pairs.set(key, {
        remoteAgentId: delivery.remoteAgentId,
        conversationId: delivery.conversationId,
      })
    }
  }
  if (pairs.size === 0) return
  const remoteAgentIds = [
    ...new Set([...pairs.values()].map((pair) => pair.remoteAgentId)),
  ]
  const bindingsResult = await runBuilder(
    db,
    db
      .selectFrom("remoteAgentBindings")
      .select(["remoteAgentId", "runtimeKind", "runtimePath", "localRootPath"])
      .where("machineId", "=", machineId)
      .where("status", "=", "active")
      .where("remoteAgentId", "in", remoteAgentIds)
  )
  const bindingByAgent = new Map(
    bindingsResult.rows.map((row) => [row.remoteAgentId, row])
  )
  const sessionResult = await runBuilder(
    db,
    db
      .selectFrom("remoteAgentConversationContexts")
      .select(["remoteAgentId", "conversationId", "runtimeSessionId"])
      .where("remoteAgentId", "in", remoteAgentIds)
      .where("conversationId", "in", [
        ...new Set([...pairs.values()].map((pair) => pair.conversationId)),
      ])
  )
  const sessionByPair = new Map(
    sessionResult.rows.map((row) => [
      `${row.remoteAgentId}:${row.conversationId}`,
      row.runtimeSessionId,
    ])
  )
  for (const pair of pairs.values()) {
    const binding = bindingByAgent.get(pair.remoteAgentId)
    if (!binding) continue
    safeSend(connection, {
      type: "agent:start",
      remoteAgentId: pair.remoteAgentId,
      conversationId: pair.conversationId,
      runtimeKind: binding.runtimeKind,
      runtimePath: binding.runtimePath,
      localRootPath: binding.localRootPath,
      sessionId:
        sessionByPair.get(`${pair.remoteAgentId}:${pair.conversationId}`) ??
        null,
      fencingToken: connection.fencingToken,
      serverUrl: config.app.baseUrl,
    })
  }
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
    const now = Date.now()
    const inFlight = pruneInFlightDeliveryMap(machineId, now)
    const pendingForSend = deliveries.filter(
      (delivery) => !inFlight.has(delivery.deliveryId)
    )
    if (pendingForSend.length === 0) {
      continue
    }
    // Prefix each batch with agent:start frames so the daemon ALWAYS knows
    // which driver to spawn for an unfamiliar (agent, conversation). Without
    // this the daemon's ManagedRemoteAgent falls back to its default
    // runtimeKind ("claude_code") when agent:deliver arrives for an agent
    // it has never seen — that silently routes Codex agents through the
    // Claude driver. configure() + ensureRuntimeForConversation are
    // idempotent, so re-sending the prefix on every batch is cheap and
    // robust.
    await sendAgentStartPrefix(connection, pendingForSend, machineId)
    const sent = safeSend(connection, {
      type: "agent:deliver",
      deliveries: pendingForSend,
    })
    if (sent) {
      markInFlightDeliveries(
        machineId,
        pendingForSend.map((delivery) => delivery.deliveryId),
        now
      )
    } else {
      await scheduleDeliveryRetry(
        machineId,
        pendingForSend.map((delivery) => delivery.deliveryId),
        "WebSocket push failed"
      )
    }
  }
}

async function scheduleDeliveryRetry(
  machineId: string | null,
  deliveryIds: string[],
  reason: string,
  queryable: Executor = db
) {
  if (deliveryIds.length === 0) return
  if (machineId) {
    clearInFlightDeliveries(machineId, deliveryIds)
  }
  const updated = await runBuilder(
    queryable,
    queryable
      .updateTable("remoteAgentMessageDeliveries")
      .set({
        attempts: sql`attempts + 1`,
        lastFailureReason: reason,
      })
      .where("id", "in", deliveryIds)
      .where("status", "=", "pending")
      .returning(["id", "attempts"])
  )
  const now = new Date()
  for (const row of updated.rows) {
    if (shouldFailDelivery(row.attempts)) {
      await queryable
        .updateTable("remoteAgentMessageDeliveries")
        .set({
          status: "failed",
          nextAttemptAt: null,
        })
        .where("id", "=", row.id)
        .execute()
      continue
    }
    const scheduled = nextAttemptAt(now, row.attempts)
    await queryable
      .updateTable("remoteAgentMessageDeliveries")
      .set({
        nextAttemptAt: scheduled,
      })
      .where("id", "=", row.id)
      .execute()
  }
}

export async function failRemoteAgentDeliveries(params: {
  remoteAgentId: string
  machineKey: string
  deliveryIds: string[]
  reason?: string
}) {
  const machine = await authenticateMachineForRemoteAgent(params)
  const uniqueIds = [...new Set(params.deliveryIds.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return { rescheduled: 0 }
  }
  const owned = await runBuilder(
    db,
    db
      .selectFrom("remoteAgentMessageDeliveries")
      .select("id")
      .where("remoteAgentId", "=", params.remoteAgentId)
      .where("id", "in", uniqueIds)
      .where("status", "=", "pending")
  )
  const ownedIds = owned.rows.map((row) => row.id)
  if (ownedIds.length === 0) {
    return { rescheduled: 0 }
  }
  await scheduleDeliveryRetry(
    machine.machineId,
    ownedIds,
    params.reason?.trim() || "Daemon reported failure"
  )
  return { rescheduled: ownedIds.length }
}

export async function runDueRemoteAgentDeliveryRetries() {
  const dueRows = await runOnDb<{
    delivery_id: string
    remote_agent_id: string
    machine_id: string | null
  }>(
    `
      SELECT
        delivery.id AS delivery_id,
        delivery.remote_agent_id,
        binding.machine_id
      FROM remote_agent_message_deliveries delivery
      LEFT JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = delivery.remote_agent_id
       AND binding.status = 'active'
      WHERE delivery.status = 'pending'
        AND delivery.next_attempt_at IS NOT NULL
        AND delivery.next_attempt_at <= NOW()
      ORDER BY delivery.next_attempt_at ASC
      LIMIT 200
    `
  )
  if (dueRows.rows.length === 0) {
    return { rechecked: 0 }
  }

  const byMachine = new Map<string, string[]>()
  for (const row of dueRows.rows) {
    if (!row.machine_id) continue
    const list = byMachine.get(row.machine_id) ?? []
    list.push(row.remote_agent_id)
    byMachine.set(row.machine_id, list)
  }

  for (const [machineId, remoteAgentIds] of byMachine) {
    await notifyPendingRemoteAgentDeliveries({
      machineId,
      remoteAgentIds: [...new Set(remoteAgentIds)],
    })
  }

  return { rechecked: dueRows.rows.length }
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

export async function authenticateMachineForRemoteAgent(params: {
  remoteAgentId: string
  machineKey: string
}) {
  if (!params.machineKey) {
    throw new Error("Machine key is required")
  }
  const machine = await loadMachineByApiKey(params.machineKey)
  if (
    !machine ||
    machine.trustStatus !== REMOTE_AGENT_MACHINE_TRUST_STATUS.ACTIVE
  ) {
    throw new Error("Machine authentication failed")
  }

  const result = await runOnDb<{
    remote_agent_id: string
    machine_id: string
    workspace_id: string
    local_root_path: string | null
  }>(
    `
      SELECT
        binding.remote_agent_id,
        binding.machine_id,
        app.workspace_id,
        binding.local_root_path
      FROM remote_agent_bindings binding
      INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
      INNER JOIN workspace_apps_live app
        ON app.id = agent.id
      WHERE binding.remote_agent_id = $1
        AND binding.machine_id = $2
        AND binding.status = 'active'
        AND app.deleted_at IS NULL
        AND app.status = 'active'
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
  queryable: Executor = db
) {
  const result = await runBuilder(
    queryable,
    queryable
      .selectFrom("conversations")
      .select("workspaceId")
      .where("id", "=", conversationId)
      .limit(1)
  )
  return result.rows[0]?.workspaceId ?? null
}

function mapRuntimeSummaryFromRow(row: {
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
}): RemoteAgentRuntimeSummaryView {
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

const LATEST_CONVERSATION_CONTEXT_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      ctx.conversation_id AS latest_active_conversation_id,
      ctx.runtime_session_id AS latest_runtime_session_id,
      ctx.active_task_id AS latest_active_task_id,
      ctx.last_run_started_at AS latest_last_run_started_at,
      ctx.last_run_finished_at AS latest_last_run_finished_at
    FROM remote_agent_conversation_contexts ctx
    WHERE ctx.remote_agent_id = binding.remote_agent_id
    ORDER BY
      CASE ctx.runtime_state
        WHEN 'running' THEN 0
        WHEN 'waiting_user_input' THEN 0
        WHEN 'plan_drafting' THEN 0
        WHEN 'waiting_plan_approval' THEN 0
        WHEN 'idle' THEN 1
        WHEN 'error' THEN 2
        ELSE 3
      END,
      ctx.last_activity_at DESC NULLS LAST,
      ctx.updated_at DESC
    LIMIT 1
  ) latest_ctx ON TRUE
`

async function ensureRemoteAgentRun(params: {
  remoteAgentId: string
  conversationId?: string | null
  runKey: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  statusText?: string | null
  lastError?: string | null
  queryable?: Executor
}) {
  const queryable = params.queryable ?? db
  const existing = await runBuilder(
    queryable,
    queryable
      .selectFrom("remoteAgentRuns")
      .select("id")
      .where("runKey", "=", params.runKey)
      .limit(1)
  )
  if (existing.rows[0]?.id) {
    await runOn(
      queryable,
      `
        UPDATE remote_agent_runs
        SET conversation_id = COALESCE($2, conversation_id),
            status = $3::remote_agent_runs_status,
            status_text = $4,
            -- Same NULL/empty/non-empty sentinel as the contexts and
            -- bindings updates: a successful run-update tick shouldn't
            -- clobber the error message that a previous tick recorded
            -- for this run row.
            last_error = CASE
              WHEN $5::text IS NULL THEN remote_agent_runs.last_error
              WHEN $5::text = '' THEN NULL
              ELSE $5::text
            END,
            started_at = COALESCE(
              started_at,
              CASE WHEN $3::text = 'running' THEN NOW() ELSE NULL END
            ),
            ended_at = CASE
              WHEN $3::text IN ('completed', 'failed', 'cancelled') THEN NOW()
              ELSE NULL
            END
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

  const inserted = await runOn<{ id: string }>(
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
        -- Same NULLIF sentinel as the contexts INSERT above (and the
        -- CASE in this table's UPDATE arm) so a fresh run started with
        -- lastError="" does not persist an empty string.
        NULLIF($6, ''),
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
  options: {
    /**
     * When provided, the returned snapshot is scoped to this conversation:
     * runtime_state / status_text / last_error / session_id / active task
     * come from the (remote_agent_id, conversation_id) context row, not
     * the binding row or the "most representative context" LATERAL pick.
     *
     * Without this scoping the chat page would render conversation A's
     * runtime view using whichever context happened to win the LATERAL's
     * priority ordering (running > idle > error > offline, then most
     * recent activity), so a parallel conversation B that was running
     * would shadow A's true state and vice versa. Core execution is
     * already isolated per-conversation (one CC/Codex session each), but
     * the user-visible state read path was still binding/global.
     */
    conversationId?: string | null
    queryable?: Executor
  } = {}
) {
  const queryable: Executor = options.queryable ?? db
  const conversationId = options.conversationId ?? null
  // The LATERAL also pulls runtime_state / status_text / last_error from
  // the context row so we can prefer them over the binding-level values
  // when a conversationId scope was requested.
  const lateral = `
    LEFT JOIN LATERAL (
      SELECT
        ctx.conversation_id AS latest_active_conversation_id,
        ctx.runtime_session_id AS latest_runtime_session_id,
        ctx.runtime_state AS ctx_runtime_state,
        ctx.status_text AS ctx_status_text,
        ctx.last_error AS ctx_last_error,
        ctx.active_task_id AS latest_active_task_id,
        ctx.last_run_started_at AS latest_last_run_started_at,
        ctx.last_run_finished_at AS latest_last_run_finished_at,
        ctx.last_activity_at AS ctx_last_activity_at
      FROM remote_agent_conversation_contexts ctx
      WHERE ctx.remote_agent_id = binding.remote_agent_id
        ${conversationId ? "AND ctx.conversation_id = $2" : ""}
      ORDER BY
        CASE ctx.runtime_state
          WHEN 'running' THEN 0
          WHEN 'waiting_user_input' THEN 0
          WHEN 'plan_drafting' THEN 0
          WHEN 'waiting_plan_approval' THEN 0
          WHEN 'idle' THEN 1
          WHEN 'error' THEN 2
          ELSE 3
        END,
        ctx.last_activity_at DESC NULLS LAST,
        ctx.updated_at DESC
      LIMIT 1
    ) latest_ctx ON TRUE
  `
  const result = await runOn<{
    remote_agent_id: string
    runtime_kind: RemoteAgentRuntimeKind
    runtime_state: RemoteAgentRuntimeStateType
    status_text: string | null
    latest_active_conversation_id: string | null
    latest_active_task_id: string | null
    latest_runtime_session_id: string | null
    last_activity_at: Date | null
    latest_last_run_started_at: Date | null
    latest_last_run_finished_at: Date | null
    last_error: string | null
    updated_at: Date
    pending_conversation_count: string | number
    unread_delivery_count: string | number
    capabilities: unknown
    ctx_runtime_state: RemoteAgentRuntimeStateType | null
    ctx_status_text: string | null
    ctx_last_error: string | null
    ctx_last_activity_at: Date | null
  }>(
    queryable,
    `
      SELECT
        binding.remote_agent_id,
        binding.runtime_kind,
        binding.runtime_state,
        binding.status_text,
        latest_ctx.latest_active_conversation_id,
        latest_ctx.latest_active_task_id,
        latest_ctx.latest_runtime_session_id,
        binding.last_activity_at,
        latest_ctx.latest_last_run_started_at,
        latest_ctx.latest_last_run_finished_at,
        binding.last_error,
        binding.updated_at,
        latest_ctx.ctx_runtime_state,
        latest_ctx.ctx_status_text,
        latest_ctx.ctx_last_error,
        latest_ctx.ctx_last_activity_at,
        COALESCE(
          (
            SELECT COUNT(DISTINCT delivery.conversation_id)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
              ${conversationId ? "AND delivery.conversation_id = $2" : ""}
          ),
          0
        ) AS pending_conversation_count,
        COALESCE(
          (
            SELECT COUNT(*)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
              ${conversationId ? "AND delivery.conversation_id = $2" : ""}
          ),
          0
        ) AS unread_delivery_count,
        binding.capabilities
      FROM remote_agent_bindings binding
      ${lateral}
      WHERE binding.remote_agent_id = $1
      LIMIT 1
    `,
    conversationId ? [remoteAgentId, conversationId] : [remoteAgentId]
  )
  const row = result.rows[0]
  if (!row) {
    return null
  }
  // Scoped to a conversation: the per-context row is the *only* authority
  // for what that conversation's view should show. Falling back to binding
  // when the context row is missing would leak some sibling conversation's
  // state into A's view (binding now aggregates across contexts; even with
  // aggregation, the right answer for "conversation A has never started"
  // is 'offline' for THIS conversation, not the aggregate of others).
  // Unscoped: keep the historical agent-overview behavior — binding state
  // is the aggregate, so use it directly.
  const scopedToConversation = conversationId !== null
  const runtimeState = scopedToConversation
    ? (row.ctx_runtime_state ?? "offline")
    : row.runtime_state
  const statusText = scopedToConversation
    ? row.ctx_status_text
    : row.status_text
  const lastErrorMessage = scopedToConversation
    ? row.ctx_last_error
    : row.last_error
  // last_activity_at must follow the same scoping: scoped reads the
  // context's activity stamp (when the agent last did anything in THIS
  // conversation), unscoped reads binding's aggregate.
  const lastActivityAt = scopedToConversation
    ? row.ctx_last_activity_at
    : row.last_activity_at
  const lastErrorActivityAt = lastActivityAt
  const updatedAt = serializeInstant(
    requireInstantDate(
      row.updated_at,
      `Remote agent ${row.remote_agent_id} updated_at`
    )
  )
  const lastErrorAt =
    serializeOptionalInstant(lastErrorActivityAt) ||
    serializeInstant(
      requireInstantDate(
        row.updated_at,
        `Remote agent ${row.remote_agent_id} updated_at`
      )
    )
  return {
    remoteAgentId: row.remote_agent_id,
    runtimeKind: row.runtime_kind,
    state: runtimeState,
    statusText: statusText ?? undefined,
    activeConversationId: row.latest_active_conversation_id ?? undefined,
    activeTaskId: row.latest_active_task_id ?? undefined,
    sessionId: row.latest_runtime_session_id ?? undefined,
    pendingConversationCount: Number(row.pending_conversation_count ?? 0),
    unreadDeliveryCount: Number(row.unread_delivery_count ?? 0),
    lastActivityAt: serializeOptionalInstant(lastActivityAt),
    lastRunStartedAt: serializeOptionalInstant(row.latest_last_run_started_at),
    lastRunFinishedAt: serializeOptionalInstant(
      row.latest_last_run_finished_at
    ),
    lastError:
      lastErrorMessage && lastErrorAt
        ? {
            message: lastErrorMessage,
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
  queryable: Executor = db
) {
  const snapshot = await loadRemoteAgentRuntimeSnapshot(remoteAgentId, {
    queryable,
  })
  if (!snapshot) {
    return null
  }
  const recipients = await runOn<{
    workspace_id: string
    workspace_member_id: string
  }>(
    queryable,
    `
      SELECT DISTINCT member.workspace_id, viewer_subj.workspace_member_id
      FROM conversation_participants agent_cp
      INNER JOIN access_subjects agent_subj ON agent_subj.id = agent_cp.subject_id
      INNER JOIN conversation_participants viewer
        ON viewer.conversation_id = agent_cp.conversation_id
       AND viewer.state = 'active'
      INNER JOIN access_subjects viewer_subj ON viewer_subj.id = viewer.subject_id
       AND viewer_subj.workspace_member_id IS NOT NULL
      INNER JOIN workspace_members member
        ON member.id = viewer_subj.workspace_member_id
      WHERE agent_subj.remote_agent_id = $1
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
}) {
  const runtimeSummary = row.machine_id
    ? mapRuntimeSummaryFromRow(row)
    : undefined
  const requiresContactApproval = await deriveRequiresContactApproval(
    db,
    "remote_agent",
    row.id,
    row.workspace_id
  )
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

export async function listRemoteAgents(params: {
  workspaceId: string
  userId: string
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const visibleIds = await listAuthorizedResourceIds(db, {
    subject: {
      type: "workspace_member",
      id: identity.workspaceMemberId,
    },
    action: "remote_agent.view",
  })
  if (visibleIds.length === 0) {
    return { remoteAgents: [] }
  }
  const result = await runOnDb<any>(
    `
      SELECT
        agent.*,
        app.workspace_id AS workspace_id,
        app.display_name AS display_name,
        app.owner_workspace_member_id AS owner_workspace_member_id,
        (app.status = 'active') AS is_active,
        binding.machine_id,
        machine.title AS machine_title,
        binding.status AS binding_status,
        binding.runtime_path,
        binding.local_root_path,
        machine.lifecycle_state AS machine_lifecycle_state,
        binding.runtime_state,
        binding.status_text,
        latest_ctx.latest_runtime_session_id,
        latest_ctx.latest_active_conversation_id,
        latest_ctx.latest_active_task_id,
        binding.last_activity_at,
        latest_ctx.latest_last_run_started_at,
        latest_ctx.latest_last_run_finished_at,
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
      INNER JOIN workspace_apps_live app
        ON app.id = agent.id
      LEFT JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = agent.id
      LEFT JOIN remote_agent_machines machine
        ON machine.id = binding.machine_id
      ${LATEST_CONVERSATION_CONTEXT_LATERAL}
      WHERE app.workspace_id = $1
        AND app.deleted_at IS NULL
        AND agent.id = ANY($2::uuid[])
      ORDER BY agent.created_at DESC, agent.id DESC
    `,
    [params.workspaceId, visibleIds]
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
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const allowed = await authorizeAction(db, {
    subject: {
      type: "workspace_member",
      id: identity.workspaceMemberId,
    },
    action: "remote_agent.view",
    resourceId: params.remoteAgentId,
  })
  if (!allowed) {
    throw new Error("Not allowed to view this remote agent")
  }
  const result = await runOnDb<any>(
    `
      SELECT
        agent.*,
        app.workspace_id AS workspace_id,
        app.display_name AS display_name,
        app.owner_workspace_member_id AS owner_workspace_member_id,
        (app.status = 'active') AS is_active,
        binding.machine_id,
        machine.title AS machine_title,
        binding.status AS binding_status,
        binding.runtime_path,
        binding.local_root_path,
        machine.lifecycle_state AS machine_lifecycle_state,
        binding.runtime_state,
        binding.status_text,
        latest_ctx.latest_runtime_session_id,
        latest_ctx.latest_active_conversation_id,
        latest_ctx.latest_active_task_id,
        binding.last_activity_at,
        latest_ctx.latest_last_run_started_at,
        latest_ctx.latest_last_run_finished_at,
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
      INNER JOIN workspace_apps_live app
        ON app.id = agent.id
      LEFT JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = agent.id
      LEFT JOIN remote_agent_machines machine
        ON machine.id = binding.machine_id
      ${LATEST_CONVERSATION_CONTEXT_LATERAL}
      WHERE app.workspace_id = $1
        AND app.deleted_at IS NULL
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
  displayName: string
  title: string
  description?: string
  runtimeKind: RemoteAgentRuntimeKind
  avatarFileId?: string
  avatarEmoji?: string
  isPublicShared?: boolean
  metadata?: Record<string, unknown>
  grants?: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceAppGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const insertedRow = await withDbTransaction(async (client) => {
    const remoteAgentId = crypto.randomUUID()
    await insertWorkspaceAppRoot(client, {
      id: remoteAgentId,
      workspaceId: params.workspaceId,
      kind: "remote_agent",
      displayName: params.displayName.trim(),
      ownerWorkspaceMemberId: identity.workspaceMemberId,
      status: "active",
    })
    const result = await runOn<any>(
      client,
      `
        INSERT INTO remote_agents (
          id,
          title,
          description,
          runtime_kind,
          avatar_file_id,
          avatar_emoji,
          is_public_shared,
          metadata,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
        RETURNING *
      `,
      [
        remoteAgentId,
        params.title.trim(),
        params.description?.trim() || null,
        params.runtimeKind,
        params.avatarFileId ?? null,
        params.avatarEmoji ?? null,
        params.isPublicShared === true,
        JSON.stringify(params.metadata ?? {}),
      ]
    )
    const row = result.rows[0]!
    for (const grant of params.grants || []) {
      await insertWorkspaceAppGrant(client, {
        workspaceId: params.workspaceId,
        workspaceAppId: row.id,
        target: grant.target,
        permissions: grant.permissions,
        conversationTypeMaskOverride:
          grant.conversationTypeMaskOverride ?? null,
        createdByWorkspaceMemberId: identity.workspaceMemberId,
        reason: grant.reason ?? null,
      })
    }
    return row
  })
  return {
    remoteAgent: await mapRemoteAgentRow({
      ...insertedRow,
      workspace_id: params.workspaceId,
      display_name: params.displayName.trim(),
      owner_workspace_member_id: identity.workspaceMemberId,
      is_active: true,
    }),
  }
}

export async function updateRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
  displayName?: string
  title?: string
  description?: string | null
  avatarFileId?: string | null
  avatarEmoji?: string | null
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

  await runOnDb<any>(
    `
      UPDATE remote_agents
      SET title = $3,
          description = $4,
          avatar_file_id = $5,
          avatar_emoji = $6,
          is_public_shared = $7,
          metadata = $8::jsonb,
          updated_at = NOW()
      WHERE id = $2
        AND EXISTS (
          SELECT 1
          FROM workspace_apps_live app
          WHERE app.id = remote_agents.id
            AND app.workspace_id = $1
            AND app.deleted_at IS NULL
        )
      RETURNING *
    `,
    [
      params.workspaceId,
      params.remoteAgentId,
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
      params.isPublicShared ?? existing.remoteAgent.isPublicShared,
      JSON.stringify(nextMetadata),
    ]
  )
  await updateWorkspaceAppRoot(db, {
    id: params.remoteAgentId,
    displayName: params.displayName?.trim() || existing.remoteAgent.displayName,
    status:
      (params.isActive ?? existing.remoteAgent.isActive)
        ? "active"
        : "disabled",
  })
  return getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
}

export async function deleteRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  // Root lifecycle lives on workspace_apps. The detail row stays until purge.
  await updateWorkspaceAppRoot(db, {
    id: params.remoteAgentId,
    status: "archived",
    deletedAt: new Date(),
  })
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
  const result = await runBuilder(
    db,
    db
      .insertInto("remoteAgentMachines")
      .values({
        workspaceId: params.workspaceId,
        title: params.title?.trim() || "Remote Agent Machine",
        description: params.description?.trim() || null,
        apiKeyHash: hashMachineApiKey(apiKey),
        trustStatus: "active",
        createdByWorkspaceMemberId: identity.workspaceMemberId,
        createdAt: sql`NOW()`,
      })
      .returningAll()
  )

  return {
    machine: {
      id: result.rows[0]!.id,
      workspaceId: result.rows[0]!.workspaceId,
      title: result.rows[0]!.title,
      description: result.rows[0]!.description ?? undefined,
      trustStatus: result.rows[0]!.trustStatus,
      lifecycleState: result.rows[0]!.lifecycleState ?? undefined,
      lastSeenAt: serializeOptionalInstant(result.rows[0]!.lastSeenAt),
      createdAt: serializeOptionalInstant(result.rows[0]!.createdAt),
      updatedAt: serializeOptionalInstant(result.rows[0]!.updatedAt),
    },
    apiKey,
    daemonCommand: buildDaemonCommand(apiKey),
    oneClickCommands: buildDaemonOneClick(apiKey),
  }
}

export async function listRemoteAgentMachines(params: {
  workspaceId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const result = await runOnDb<any>(
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
      lastSeenAt: serializeOptionalInstant(row.last_seen_at),
      createdAt: serializeOptionalInstant(row.created_at),
      updatedAt: serializeOptionalInstant(row.updated_at),
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
    runBuilder(
      db,
      db
        .selectFrom("remoteAgentMachines")
        .selectAll()
        .where("workspaceId", "=", params.workspaceId)
        .where("id", "=", params.machineId)
        .limit(1)
    ),
    runBuilder(
      db,
      db
        .selectFrom("remoteAgentRuntimeCatalog")
        .selectAll()
        .where("machineId", "=", params.machineId)
        .orderBy("runtimeKind", "asc")
    ),
    runOnDb<any>(
      `
        SELECT
          binding.remote_agent_id,
          binding.runtime_kind,
          binding.runtime_path,
          binding.local_root_path,
          binding.status,
          binding.runtime_state,
          binding.status_text,
          latest_ctx.latest_runtime_session_id,
          latest_ctx.latest_active_conversation_id,
          latest_ctx.latest_active_task_id,
          binding.last_activity_at,
          latest_ctx.latest_last_run_started_at,
          latest_ctx.latest_last_run_finished_at,
          binding.last_error,
          binding.capabilities,
          app.display_name,
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
        INNER JOIN workspace_apps_live app ON app.id = agent.id
        ${LATEST_CONVERSATION_CONTEXT_LATERAL}
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
      workspaceId: machine.workspaceId,
      title: machine.title,
      description: machine.description ?? undefined,
      trustStatus: machine.trustStatus,
      lifecycleState: machine.lifecycleState ?? undefined,
      lastSeenAt: serializeOptionalInstant(machine.lastSeenAt),
      createdAt: serializeOptionalInstant(machine.createdAt),
      updatedAt: serializeOptionalInstant(machine.updatedAt),
    },
    runtimeCatalog: catalogResult.rows.map((row) => ({
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
    })),
    bindings: bindingResult.rows.map((row) => ({
      remoteAgentId: row.remote_agent_id,
      displayName: row.display_name,
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

  const machineResult = await runBuilder(
    db,
    db
      .selectFrom("remoteAgentMachines")
      .select("id")
      .where("workspaceId", "=", params.workspaceId)
      .where("id", "=", params.machineId)
      .limit(1)
  )
  if (!machineResult.rows[0]) {
    throw new Error("Machine not found")
  }

  const catalogResult = await runBuilder(
    db,
    db
      .selectFrom("remoteAgentRuntimeCatalog")
      .select(["executablePath", "status", "lastError"])
      .where("machineId", "=", params.machineId)
      .where("runtimeKind", "=", params.runtimeKind)
      .limit(1)
  )

  const catalogEntry = catalogResult.rows[0] ?? null
  if (!params.runtimePath) {
    if (!catalogEntry) {
      throw new Error("Machine has not reported runtime availability yet")
    }
    if (catalogEntry.status !== REMOTE_AGENT_RUNTIME_CATALOG_STATUS.AVAILABLE) {
      const detail = catalogEntry.lastError?.trim()
        ? `: ${catalogEntry.lastError.trim()}`
        : ""
      throw new Error(
        `Runtime ${params.runtimeKind} is not available on this machine (${catalogEntry.status})${detail}`
      )
    }
  }

  const effectiveRuntimePath =
    params.runtimePath ?? catalogEntry?.executablePath ?? null

  await db
    .insertInto("remoteAgentBindings")
    .values({
      remoteAgentId: params.remoteAgentId,
      machineId: params.machineId,
      runtimeKind: params.runtimeKind,
      runtimePath: effectiveRuntimePath,
      localRootPath: params.localRootPath ?? null,
      status: "active",
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.column("remoteAgentId").doUpdateSet({
        machineId: sql`EXCLUDED.machine_id`,
        runtimeKind: sql`EXCLUDED.runtime_kind`,
        runtimePath: sql`EXCLUDED.runtime_path`,
        localRootPath: sql`EXCLUDED.local_root_path`,
        status: "active",
      })
    )
    .execute()

  await startBoundRemoteAgents(params.machineId)
  return getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
}

export async function listRemoteAgentGroupTaskGrants(params: {
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
  const result = await runOnDb<{
    workspace_member_id: string
    granted_by_workspace_member_id: string | null
    created_at: Date
    updated_at: Date
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
      FROM remote_agent_group_task_grants grant_row
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
      avatarUrl: row.user_avatar_file_id
        ? getFileUrlById(row.user_avatar_file_id)
        : undefined,
    })),
  }
}

export async function updateRemoteAgentGroupTaskGrants(params: {
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
    const membership = await runBuilder(
      db,
      db
        .selectFrom("workspaceMembers")
        .select("id")
        .where("workspaceId", "=", params.workspaceId)
        .where("id", "in", nextIds)
    )
    if (membership.rows.length !== nextIds.length) {
      throw new Error("Some workspace members are invalid")
    }
  }

  await withDbTransaction(async (client) => {
    // set-replace of a derived grants table → SECURITY DEFINER fn (§7.5).
    await sql`SELECT sd_replace_remote_agent_group_grants(${params.remoteAgentId}::uuid)`.execute(
      client
    )
    for (const workspaceMemberId of nextIds) {
      await client
        .insertInto("remoteAgentGroupTaskGrants")
        .values({
          remoteAgentId: params.remoteAgentId,
          workspaceMemberId: workspaceMemberId,
          grantedByWorkspaceMemberId: identity.workspaceMemberId,
          createdAt: sql`NOW()`,
        })
        .execute()
    }
  })

  return listRemoteAgentGroupTaskGrants(params)
}

export async function createRemoteAgentUserInputTask(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  runKey: string
  title: string
  instructions?: string
  questions: Array<Record<string, unknown>>
  expiresAt?: Timestamp
}) {
  const access = await authenticateMachineForRemoteAgent(params)
  const conversationAccess = await requireRemoteAgentConversationAccess(
    db,
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
  const { createRemoteAgentUserInputTaskRequest } =
    await import("../tasks/service.js")
  const task = await createRemoteAgentUserInputTaskRequest({
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
    state: REMOTE_AGENT_RUNTIME_STATE.WAITING_USER_INPUT,
    statusText: params.title,
    conversationId: params.conversationId,
    taskId: task.id,
    runKey: params.runKey,
  })
  return { task }
}

export async function createRemoteAgentPlanApprovalTask(params: {
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
  expiresAt?: Timestamp
}) {
  const access = await authenticateMachineForRemoteAgent(params)
  const conversationAccess = await requireRemoteAgentConversationAccess(
    db,
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
  const { createRemoteAgentPlanApprovalTaskRequest } =
    await import("../tasks/service.js")
  const task = await createRemoteAgentPlanApprovalTaskRequest({
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
    state: REMOTE_AGENT_RUNTIME_STATE.WAITING_PLAN_APPROVAL,
    statusText: params.title,
    conversationId: params.conversationId,
    taskId: task.id,
    runKey: params.runKey,
  })
  return { task }
}

export async function createRemoteAgentDeliveriesForItem(params: {
  workspaceId?: string
  conversationId: string
  itemId: string
  authorParticipantId?: string
  queryable?: Executor
}) {
  const executor: Executor = params.queryable ?? db
  const runRaw = async <T = any>(text: string, values: unknown[]) => {
    const result = await executor.executeQuery<T>(
      CompiledQuery.raw(text, [...values])
    )
    return {
      rows: result.rows as T[],
      rowCount: Number(
        (result as { numAffectedRows?: bigint }).numAffectedRows ??
          result.rows.length
      ),
    }
  }
  const participants = await runRaw<{
    participant_id: string
    remote_agent_id: string
  }>(
    `
      SELECT
        cp.id AS participant_id,
        cpsubj.remote_agent_id
      FROM conversation_participants cp
      INNER JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
      WHERE cp.conversation_id = $1
        AND cp.state = 'active'
        AND cpsubj.remote_agent_id IS NOT NULL
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
    const inserted = await runBuilder(
      executor,
      executor
        .insertInto("remoteAgentMessageDeliveries")
        .values({
          remoteAgentId: participant.remote_agent_id,
          conversationId: params.conversationId,
          itemId: params.itemId,
          status: "pending",
          attempts: 0,
          createdAt: sql`NOW()`,
        })
        .onConflict((oc) => oc.columns(["remoteAgentId", "itemId"]).doNothing())
    )

    if ((inserted.rowCount ?? 0) > 0) {
      await executor
        .insertInto("remoteAgentConversationViews")
        .values({
          remoteAgentId: participant.remote_agent_id,
          conversationId: params.conversationId,
          unreadCount: 1,
          lastDeliveryItemId: params.itemId,
          lastDeliveryAt: sql`NOW()`,
          createdAt: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.columns(["remoteAgentId", "conversationId"]).doUpdateSet({
            unreadCount: sql`remote_agent_conversation_views.unread_count + 1`,
            lastDeliveryItemId: sql`EXCLUDED.last_delivery_item_id`,
            lastDeliveryAt: sql`NOW()`,
          })
        )
        .execute()
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
  const result = await runOnDb<any>(
    `
      SELECT
        c.id,
        c.kind,
        EXISTS (
          SELECT 1 FROM conversation_transport_bindings b
          WHERE b.conversation_id = c.id
        ) AS is_im,
        c.title,
        c.updated_at,
        view.unread_count
      FROM conversation_participants cp
      INNER JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
      INNER JOIN conversations c ON c.id = cp.conversation_id
      LEFT JOIN remote_agent_conversation_views view
        ON view.remote_agent_id = cpsubj.remote_agent_id
       AND view.conversation_id = cp.conversation_id
      WHERE cpsubj.remote_agent_id = $1
        AND cp.state = 'active'
      ORDER BY COALESCE(view.updated_at, c.updated_at, c.created_at) DESC, c.id ASC
    `,
    [params.remoteAgentId]
  )
  return {
    conversations: result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      isIm: Boolean(row.is_im),
      title: row.title ?? undefined,
      unreadCount: Number(row.unread_count ?? 0),
      updatedAt: serializeOptionalInstant(row.updated_at),
    })),
  }
}

export async function checkRemoteAgentMessages(params: {
  remoteAgentId: string
  machineKey: string
  conversationId?: string
  limit?: number
}) {
  await authenticateMachineForRemoteAgent(params)
  const values: any[] = [
    params.remoteAgentId,
    Math.min(Math.max(params.limit ?? 100, 1), 500),
  ]
  let conversationFilter = ""
  if (params.conversationId) {
    values.push(params.conversationId)
    conversationFilter = ` AND delivery.conversation_id = $${values.length}::uuid`
  }
  const result = await runOnDb<DeliveryRow>(
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
        ${conversationFilter}
      ORDER BY item.sequence ASC, delivery.created_at ASC
      LIMIT $2
    `,
    values
  )

  return {
    deliveries: result.rows.map((row) => ({
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
    })),
  }
}

export async function completeRemoteAgentDeliveries(params: {
  remoteAgentId: string
  machineKey: string
  deliveryIds: string[]
}) {
  const machine = await authenticateMachineForRemoteAgent(params)
  const uniqueIds = [...new Set(params.deliveryIds.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return { completed: 0 }
  }

  const rows = await runOnDb<{
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

  await db
    .updateTable("remoteAgentMessageDeliveries")
    .set({
      status: "completed",
      lastAckedAt: sql`NOW()`,
    })
    .where("remoteAgentId", "=", params.remoteAgentId)
    .where("id", "in", uniqueIds)
    .execute()
  clearInFlightDeliveries(
    machine.machineId,
    rows.rows.map((row) => row.id)
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
    await runOnDb(
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
            )
      `,
      [params.remoteAgentId, conversationId, state.itemId, state.sequence]
    )
  }

  return {
    completed: rows.rows.length,
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
    db,
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
  const item = await withDbTransaction(async (client) => {
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
    db,
    params.conversationId,
    params.remoteAgentId
  )

  const result = await runOnDb<{
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

export async function notifyRemoteAgentTaskResolved(taskId: string) {
  const { getTaskSummary } = await import("../tasks/service.js")
  const task = await getTaskSummary(taskId)
  if (
    !task ||
    task.requester?.participantType !== "remote_agent" ||
    !task.requester.remoteAgentId
  ) {
    return false
  }

  const binding = await runBuilder(
    db,
    db
      .selectFrom("remoteAgentBindings")
      .select("machineId")
      .where("remoteAgentId", "=", task.requester.remoteAgentId)
      .where("status", "=", "active")
      .limit(1)
  )
  const machineId = binding.rows[0]?.machineId
  if (!machineId) {
    return false
  }
  const connection = machineConnections.get(machineId)
  if (!connection) {
    return false
  }
  return safeSend(connection, {
    type: "agent:task:resolved",
    remoteAgentId: task.requester.remoteAgentId,
    taskId,
    task,
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
  const tracked = machineConnections.get(connection.machineId)
  if (tracked && tracked.fencingToken === connection.fencingToken) {
    machineConnections.delete(connection.machineId)
    deliveryInFlightByMachine.delete(connection.machineId)
  }
  await db
    .updateTable("remoteAgentMachineSessions")
    .set({
      status: "closed",
      closeReason: sql`COALESCE(${closeReason ?? null}, close_reason)`,
      endedAt: sql`NOW()`,
    })
    .where("id", "=", connection.sessionId)
    .where("status", "!=", "closed")
    .execute()
  if (!tracked || tracked.fencingToken !== connection.fencingToken) {
    return
  }
  await setMachineLifecycleState(
    connection.machineId,
    REMOTE_AGENT_MACHINE_LIFECYCLE_STATE.OFFLINE
  )
  const bindings = await loadBoundRemoteAgentsForMachine(connection.machineId)
  for (const binding of bindings) {
    await db
      .updateTable("remoteAgentBindings")
      .set({
        runtimeState: "offline",
        statusText: closeReason ?? "Daemon disconnected",
      })
      .where("remoteAgentId", "=", binding.remote_agent_id)
      .execute()
    await db
      .updateTable("remoteAgentConversationContexts")
      .set({
        runtimeState: "offline",
        statusText: closeReason ?? "Daemon disconnected",
        lastRunFinishedAt: sql`COALESCE(last_run_finished_at, NOW())`,
      })
      .where("remoteAgentId", "=", binding.remote_agent_id)
      .where("runtimeState", "in", [
        "running",
        "waiting_user_input",
        "plan_drafting",
        "waiting_plan_approval",
      ])
      .execute()
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
  if (
    !machine ||
    machine.trustStatus !== REMOTE_AGENT_MACHINE_TRUST_STATUS.ACTIVE
  ) {
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

  const existing = machineConnections.get(machine.id)
  if (existing) {
    try {
      existing.socket.send(
        JSON.stringify({
          type: "fenced",
          reason: "superseded by newer daemon connection",
        })
      )
    } catch {}
    try {
      existing.socket.close(4001, "superseded")
    } catch {}
    machineConnections.delete(machine.id)
    await db
      .updateTable("remoteAgentMachineSessions")
      .set({
        status: "closed",
        closeReason: "superseded by newer connection",
        endedAt: sql`NOW()`,
      })
      .where("id", "=", existing.sessionId)
      .where("status", "!=", "closed")
      .execute()
  }

  await db
    .updateTable("remoteAgentMachineSessions")
    .set({
      status: "closed",
      closeReason: sql`COALESCE(close_reason, 'superseded by newer connection')`,
      endedAt: sql`NOW()`,
    })
    .where("machineId", "=", machine.id)
    .where("status", "in", ["connecting", "active"])
    .execute()

  const sessionResult = await runBuilder(
    db,
    db
      .insertInto("remoteAgentMachineSessions")
      .values({
        machineId: machine.id,
        status: "connecting",
        transport: "websocket",
        remoteAddr: req.socket?.remoteAddress ?? null,
        lastHeartbeatAt: sql`NOW()`,
        startedAt: sql`NOW()`,
        createdAt: sql`NOW()`,
      })
      .returning(["id", "fencingToken"])
  )
  const sessionId = sessionResult.rows[0]!.id
  const fencingToken = sessionResult.rows[0]!.fencingToken

  const connection: MachineConnection = {
    machineId: machine.id,
    workspaceId: machine.workspaceId,
    sessionId,
    fencingToken,
    socket,
    ready: false,
  }
  machineConnections.set(machine.id, connection)
  await setMachineLifecycleState(
    machine.id,
    REMOTE_AGENT_MACHINE_LIFECYCLE_STATE.ONLINE
  )

  try {
    socket.send(
      JSON.stringify({
        type: "connected",
        machineId: machine.id,
        sessionId,
        fencingToken,
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

    // Fencing guard: once a newer daemon connects with the same machine key,
    // the older socket is closed via 4001, but in-flight messages from the
    // older connection can still arrive between "close initiated" and
    // "close completed". Drop them so they never write to DB or trigger
    // outbound traffic; only the current active connection (whose fencing
    // token matches the one we minted) gets to mutate state.
    const active = machineConnections.get(machine.id)
    if (!active || active.fencingToken !== fencingToken) {
      return
    }

    if (message?.type === "heartbeat") {
      await db
        .updateTable("remoteAgentMachineSessions")
        .set({
          lastHeartbeatAt: sql`NOW()`,
        })
        .where("id", "=", sessionId)
        .execute()
      try {
        socket.send(JSON.stringify({ type: "pong" }))
      } catch {}
      return
    }

    if (message?.type === "ready") {
      connection.ready = true
      await db
        .updateTable("remoteAgentMachineSessions")
        .set({
          status: "active",
          lastHeartbeatAt: sql`NOW()`,
        })
        .where("id", "=", sessionId)
        .execute()
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
      message?.type === "agent:session" &&
      typeof message.remoteAgentId === "string" &&
      typeof message.conversationId === "string"
    ) {
      const bindingRow = await runBuilder(
        db,
        db
          .selectFrom("remoteAgentBindings")
          .select("runtimeKind")
          .where("remoteAgentId", "=", message.remoteAgentId)
          .where("machineId", "=", machine.id)
          .limit(1)
      )
      await updateConversationRuntimeStatus({
        remoteAgentId: message.remoteAgentId,
        conversationId: message.conversationId,
        runtimeKind: bindingRow.rows[0]?.runtimeKind ?? null,
        state:
          typeof message.state === "string"
            ? (message.state as RemoteAgentRuntimeStateType)
            : REMOTE_AGENT_RUNTIME_STATE.RUNNING,
        sessionId:
          typeof message.sessionId === "string" ? message.sessionId : null,
      })
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
