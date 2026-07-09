import { CompiledQuery, sql } from "kysely"
import {
  type RemoteAgentLifecycleState,
  type RemoteAgentRuntimeCapabilityView,
  type RemoteAgentRuntimeKind,
  type RemoteAgentRuntimeState,
  type RemoteAgentRuntimeStateType,
  type CapabilityAccessTarget,
  type WorkspaceResourceGrantPermission,
  type WorkspaceResourceStatus,
} from "@synapse/shared"
import {
  db,
  runBuilder,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import type {
  RemoteAgentMachinesLifecycleState,
  RemoteAgentRuntimeCatalogStatus,
} from "../../infrastructure/database/generated/db.js"
import {
  presentRuntimeSnapshot,
  type MachineBindingRecord,
  type MachineListRecord,
  type RemoteAgentRow,
} from "./presenter.js"
import { deriveRequiresContactApproval } from "../access/contact-approval.js"
import {
  insertWorkspaceResourceRoot,
  updateWorkspaceResourceRoot,
} from "../workspace-resources/repo.js"
import {
  insertWorkspaceResourceGrant,
  type InsertWorkspaceResourceGrantInput,
} from "../workspace-resources/grant-storage.js"
import { appendWorkspaceMemberSyncEvent } from "../chat/sync-events.js"
import { nextAttemptAt, shouldFailDelivery } from "./delivery-retry.js"
import { activeTraceparent } from "../../infrastructure/observability/traceparent.js"

/**
 * Re-export of {@link withDbTransaction} under a module-local name so the
 * service can open a transaction (and thread the executor through repo fns)
 * without importing the db client itself — keeping the r8 db-client import
 * confined to this guard-exempt repo file.
 */
export { withDbTransaction as withRemoteAgentTransaction } from "../../infrastructure/database/kysely.js"

type RuntimeCapabilities = RemoteAgentRuntimeCapabilityView

type RuntimeCatalogEntry = {
  runtimeKind: RemoteAgentRuntimeKind
  executablePath?: string
  status: RemoteAgentRuntimeCatalogStatus
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

/** Run raw SQL (text+params) on db / trx. */
export async function runOn<T extends object = Record<string, unknown>>(
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
export function runOnDb<T extends object = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return runOn<T>(db, text, params)
}

/**
 * Pending message-delivery refs for a (remote agent, conversation) pair. Raw
 * `sql` tag bypasses the CamelCasePlugin, so the SELECT aliases item_id ->
 * itemId itself; the WHERE preserves the status = 'pending' guard verbatim.
 */
export async function listPendingDeliveryRefs(
  params: { remoteAgentId: string; conversationId: string },
  executor: Executor = db
): Promise<Array<{ id: string; itemId: string }>> {
  const result = await sql<{ id: string; itemId: string }>`
          SELECT delivery.id, delivery.item_id
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = ${params.remoteAgentId}
            AND delivery.conversation_id = ${params.conversationId}
            AND delivery.status = 'pending'
        `.execute(executor)
  return result.rows
}

/**
 * Conversation type facts (kind + whether it has any transport binding). Raw
 * `sql` tag selects is_im (snake) verbatim; the repo maps it to camelCase
 * isIm. Returns null when the conversation does not exist.
 */
export async function getConversationTypeFacts(
  conversationId: string,
  executor: Executor = db
): Promise<{ kind: "direct" | "group"; isIm: boolean } | null> {
  const result = await sql<{
    kind: "direct" | "group"
    isIm: boolean
  }>`
    SELECT kind, EXISTS (
      SELECT 1 FROM conversation_transport_bindings b
      WHERE b.conversation_id = conversations.id
    ) AS is_im
    FROM conversations WHERE id = ${conversationId} LIMIT 1`.execute(executor)
  const row = result.rows[0]
  if (!row) {
    return null
  }
  // `.execute()` runs through CamelCasePlugin's transformResult, so the
  // `AS is_im` alias arrives as `isIm`. Reading `row.is_im` here silently
  // yielded undefined → isIm:false for every IM conversation.
  return { kind: row.kind, isIm: Boolean(row.isIm) }
}

export async function loadMachineByApiKeyRepo(
  apiKeyHash: string,
  executor: Executor = db
) {
  const result = await runBuilder(
    executor,
    executor
      .selectFrom("remoteAgentMachines")
      .select(["id", "workspaceId", "trustStatus"])
      .where("apiKeyHash", "=", apiKeyHash)
      .limit(1)
  )
  return result.rows[0] ?? null
}

export async function loadBoundRemoteAgentsForMachineRepo(
  machineId: string,
  executor: Executor = db
) {
  const result = await runOn<{
    remoteAgentId: string
    runtimeKind: RemoteAgentRuntimeKind
    runtimePath: string | null
    localRootPath: string | null
  }>(
    executor,
    `
      SELECT
        binding.remote_agent_id AS "remoteAgentId",
        binding.runtime_kind AS "runtimeKind",
        binding.runtime_path AS "runtimePath",
        binding.local_root_path AS "localRootPath"
      FROM remote_agent_bindings binding
      INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
      INNER JOIN workspace_resources_live resource
        ON resource.id = agent.id
      WHERE binding.machine_id = $1
        AND binding.status = 'active'
        AND resource.deleted_at IS NULL
        AND resource.status = 'active'
      ORDER BY agent.created_at ASC, agent.id ASC
    `,
    [machineId]
  )
  return result.rows
}

export async function getOrInitConversationContextRepo(
  remoteAgentId: string,
  conversationId: string,
  runtimeKind: RemoteAgentRuntimeKind | null,
  executor: Executor = db
) {
  const result = await runBuilder(
    executor,
    executor
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

export async function updateConversationRuntimeStatusRepo(
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
  executor: Executor = db
) {
  await runOn(
    executor,
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

export async function loadAgentStartTargetsForMachineRepo(
  machineId: string,
  executor: Executor = db
) {
  // Only emit agent:start for (agent, conversation) pairs that have actual work
  // queued up. A daemon reconnect must never wake idle conversations whose
  // session id we happen to have on file — that's the "agent:start storm" the
  // refactor was meant to kill. Pending delivery is the only legitimate trigger
  // for waking a runtime; the per-conversation context's runtime_session_id is
  // passed along so the driver can resume in-place once it's waking.
  const result = await runOn<{
    remoteAgentId: string
    conversationId: string
    runtimeKind: RemoteAgentRuntimeKind
    runtimeSessionId: string | null
  }>(
    executor,
    `
      SELECT
        binding.remote_agent_id AS "remoteAgentId",
        delivery.conversation_id AS "conversationId",
        binding.runtime_kind AS "runtimeKind",
        ctx.runtime_session_id AS "runtimeSessionId"
      FROM remote_agent_bindings binding
      INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
      INNER JOIN workspace_resources_live resource
        ON resource.id = agent.id
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
        AND resource.deleted_at IS NULL
        AND resource.status = 'active'
      ORDER BY ctx.last_activity_at DESC NULLS LAST, delivery.conversation_id ASC
    `,
    [machineId]
  )
  return result.rows
}

export async function setMachineLifecycleStateRepo(
  machineId: string,
  state: RemoteAgentLifecycleState,
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentMachines")
    .set({
      lifecycleState: state as RemoteAgentMachinesLifecycleState,
      lastSeenAt: sql`NOW()`,
    })
    .where("id", "=", machineId)
    .execute()
}

export async function upsertRuntimeCatalogRepo(
  machineId: string,
  entries: RuntimeCatalogEntry[],
  executor: Executor = db
) {
  for (const entry of entries) {
    await executor
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

export async function loadReplayResolvedTaskTargetsRepo(
  machineId: string,
  remoteAgentIds: string[],
  executor: Executor = db
) {
  const rows = await runOn<{
    remoteAgentId: string
    activeTaskId: string
    lifecycleStatus: string
  }>(
    executor,
    `
      SELECT
        ctx.remote_agent_id AS "remoteAgentId",
        ctx.active_task_id AS "activeTaskId",
        task.lifecycle_status AS "lifecycleStatus"
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
    [machineId, remoteAgentIds]
  )
  return rows.rows
}

export async function loadBindingRuntimeKindRepo(
  remoteAgentId: string,
  machineId: string,
  executor: Executor = db
): Promise<RemoteAgentRuntimeKind | null> {
  const result = await runBuilder(
    executor,
    executor
      .selectFrom("remoteAgentBindings")
      .select("runtimeKind")
      .where("remoteAgentId", "=", remoteAgentId)
      .where("machineId", "=", machineId)
      .limit(1)
  )
  return result.rows[0]?.runtimeKind ?? null
}

export async function offlineContextsForAgentWideStopRepo(
  params: { remoteAgentId: string; statusText?: string | null },
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentConversationContexts")
    .set({
      runtimeState: "offline",
      statusText: params.statusText ?? null,
      lastActivityAt: sql`NOW()`,
      lastRunFinishedAt: sql`COALESCE(last_run_finished_at, NOW())`,
    })
    .where("remoteAgentId", "=", params.remoteAgentId)
    .where("runtimeState", "!=", "offline")
    .execute()
}

export async function aggregateBindingFromContextsRepo(
  params: {
    remoteAgentId: string
    machineId: string
    capabilities?: RuntimeCapabilities
  },
  executor: Executor = db
) {
  await runOn(
    executor,
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
      params.remoteAgentId,
      params.machineId,
      params.capabilities ? JSON.stringify(params.capabilities) : null,
    ]
  )
}

export async function setRemoteAgentRunTaskIdRepo(
  runId: string,
  taskId: string,
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentRuns")
    .set({
      taskId: taskId,
    })
    .where("id", "=", runId)
    .execute()
}

export async function loadPendingRemoteAgentDeliveriesRepo(
  params: {
    machineId?: string
    conversationId?: string
    remoteAgentIds?: string[]
  },
  executor: Executor = db
) {
  const values: unknown[] = []
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

  return runOn<{
    deliveryId: string
    remoteAgentId: string
    machineId: string
    itemId: string
    conversationId: string
    originTraceparent: string | null
  }>(
    executor,
    `
      SELECT
        delivery.id AS "deliveryId",
        delivery.remote_agent_id AS "remoteAgentId",
        binding.machine_id AS "machineId",
        delivery.item_id AS "itemId",
        delivery.conversation_id AS "conversationId",
        delivery.origin_traceparent AS "originTraceparent"
      FROM remote_agent_message_deliveries delivery
      INNER JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = delivery.remote_agent_id
      WHERE ${where.join("\n        AND ")}
      ORDER BY delivery.created_at ASC
    `,
    values
  )
}

export async function loadAgentStartPrefixDataRepo(
  params: {
    machineId: string
    remoteAgentIds: string[]
    conversationIds: string[]
  },
  executor: Executor = db
) {
  const bindingsResult = await runBuilder(
    executor,
    executor
      .selectFrom("remoteAgentBindings")
      .select(["remoteAgentId", "runtimeKind", "runtimePath", "localRootPath"])
      .where("machineId", "=", params.machineId)
      .where("status", "=", "active")
      .where("remoteAgentId", "in", params.remoteAgentIds)
  )
  const sessionResult = await runBuilder(
    executor,
    executor
      .selectFrom("remoteAgentConversationContexts")
      .select(["remoteAgentId", "conversationId", "runtimeSessionId"])
      .where("remoteAgentId", "in", params.remoteAgentIds)
      .where("conversationId", "in", params.conversationIds)
  )
  return {
    bindings: bindingsResult.rows,
    sessions: sessionResult.rows,
  }
}

export async function scheduleDeliveryRetryRepo(
  deliveryIds: string[],
  reason: string,
  executor: Executor = db
) {
  if (deliveryIds.length === 0) return
  const updated = await runBuilder(
    executor,
    executor
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
      await executor
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
    await executor
      .updateTable("remoteAgentMessageDeliveries")
      .set({
        nextAttemptAt: scheduled,
      })
      .where("id", "=", row.id)
      .execute()
  }
}

export async function listOwnedPendingDeliveryIdsRepo(
  remoteAgentId: string,
  uniqueIds: string[],
  executor: Executor = db
): Promise<string[]> {
  const owned = await runBuilder(
    executor,
    executor
      .selectFrom("remoteAgentMessageDeliveries")
      .select("id")
      .where("remoteAgentId", "=", remoteAgentId)
      .where("id", "in", uniqueIds)
      .where("status", "=", "pending")
  )
  return owned.rows.map((row) => row.id)
}

export async function loadDueRemoteAgentDeliveryRetriesRepo(
  executor: Executor = db
) {
  const dueRows = await runOn<{
    deliveryId: string
    remoteAgentId: string
    machineId: string | null
  }>(
    executor,
    `
      SELECT
        delivery.id AS "deliveryId",
        delivery.remote_agent_id AS "remoteAgentId",
        binding.machine_id AS "machineId"
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
  return dueRows.rows
}

export async function authenticateBindingRepo(
  remoteAgentId: string,
  machineId: string,
  executor: Executor = db
) {
  const result = await runOn<{
    remoteAgentId: string
    machineId: string
    workspaceId: string
    localRootPath: string | null
  }>(
    executor,
    `
      SELECT
        binding.remote_agent_id AS "remoteAgentId",
        binding.machine_id AS "machineId",
        resource.workspace_id AS "workspaceId",
        binding.local_root_path AS "localRootPath"
      FROM remote_agent_bindings binding
      INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
      INNER JOIN workspace_resources_live resource
        ON resource.id = agent.id
      WHERE binding.remote_agent_id = $1
        AND binding.machine_id = $2
        AND binding.status = 'active'
        AND resource.deleted_at IS NULL
        AND resource.status = 'active'
      LIMIT 1
    `,
    [remoteAgentId, machineId]
  )
  return result.rows[0] ?? null
}

export async function loadConversationHostWorkspaceIdRepo(
  conversationId: string,
  executor: Executor = db
) {
  const result = await runBuilder(
    executor,
    executor
      .selectFrom("conversations")
      .select("workspaceId")
      .where("id", "=", conversationId)
      .limit(1)
  )
  return result.rows[0]?.workspaceId ?? null
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

export async function ensureRemoteAgentRunRepo(params: {
  remoteAgentId: string
  conversationId?: string | null
  runKey: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  statusText?: string | null
  lastError?: string | null
  executor?: Executor
}) {
  const executor = params.executor ?? db
  const existing = await runBuilder(
    executor,
    executor
      .selectFrom("remoteAgentRuns")
      .select("id")
      .where("runKey", "=", params.runKey)
      .limit(1)
  )
  if (existing.rows[0]?.id) {
    await runOn(
      executor,
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
    executor,
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

export async function loadRemoteAgentRuntimeSnapshotRepo(
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
    executor?: Executor
  } = {}
) {
  const executor: Executor = options.executor ?? db
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
    remoteAgentId: string
    runtimeKind: RemoteAgentRuntimeKind
    runtimeState: RemoteAgentRuntimeStateType
    statusText: string | null
    latestActiveConversationId: string | null
    latestActiveTaskId: string | null
    latestRuntimeSessionId: string | null
    lastActivityAt: Date | null
    latestLastRunStartedAt: Date | null
    latestLastRunFinishedAt: Date | null
    lastError: string | null
    updatedAt: Date
    pendingConversationCount: string | number
    unreadDeliveryCount: string | number
    capabilities: unknown
    ctxRuntimeState: RemoteAgentRuntimeStateType | null
    ctxStatusText: string | null
    ctxLastError: string | null
    ctxLastActivityAt: Date | null
  }>(
    executor,
    `
      SELECT
        binding.remote_agent_id AS "remoteAgentId",
        binding.runtime_kind AS "runtimeKind",
        binding.runtime_state AS "runtimeState",
        binding.status_text AS "statusText",
        latest_ctx.latest_active_conversation_id AS "latestActiveConversationId",
        latest_ctx.latest_active_task_id AS "latestActiveTaskId",
        latest_ctx.latest_runtime_session_id AS "latestRuntimeSessionId",
        binding.last_activity_at AS "lastActivityAt",
        latest_ctx.latest_last_run_started_at AS "latestLastRunStartedAt",
        latest_ctx.latest_last_run_finished_at AS "latestLastRunFinishedAt",
        binding.last_error AS "lastError",
        binding.updated_at AS "updatedAt",
        latest_ctx.ctx_runtime_state AS "ctxRuntimeState",
        latest_ctx.ctx_status_text AS "ctxStatusText",
        latest_ctx.ctx_last_error AS "ctxLastError",
        latest_ctx.ctx_last_activity_at AS "ctxLastActivityAt",
        COALESCE(
          (
            SELECT COUNT(DISTINCT delivery.conversation_id)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
              ${conversationId ? "AND delivery.conversation_id = $2" : ""}
          ),
          0
        ) AS "pendingConversationCount",
        COALESCE(
          (
            SELECT COUNT(*)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
              ${conversationId ? "AND delivery.conversation_id = $2" : ""}
          ),
          0
        ) AS "unreadDeliveryCount",
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
    ? (row.ctxRuntimeState ?? "offline")
    : row.runtimeState
  const statusText = scopedToConversation ? row.ctxStatusText : row.statusText
  const lastErrorMessage = scopedToConversation
    ? row.ctxLastError
    : row.lastError
  // last_activity_at must follow the same scoping: scoped reads the
  // context's activity stamp (when the agent last did anything in THIS
  // conversation), unscoped reads binding's aggregate.
  const lastActivityAt = scopedToConversation
    ? row.ctxLastActivityAt
    : row.lastActivityAt
  const lastErrorActivityAt = lastActivityAt
  return presentRuntimeSnapshot({
    remoteAgentId: row.remoteAgentId,
    runtimeKind: row.runtimeKind,
    state: runtimeState,
    statusText,
    latestActiveConversationId: row.latestActiveConversationId,
    latestActiveTaskId: row.latestActiveTaskId,
    latestRuntimeSessionId: row.latestRuntimeSessionId,
    pendingConversationCount: row.pendingConversationCount,
    unreadDeliveryCount: row.unreadDeliveryCount,
    lastActivityAt,
    latestLastRunStartedAt: row.latestLastRunStartedAt,
    latestLastRunFinishedAt: row.latestLastRunFinishedAt,
    lastErrorMessage,
    lastErrorActivityAt,
    updatedAtSource: row.updatedAt,
    updatedAtErrorLabel: `Remote agent ${row.remoteAgentId} updated_at`,
    capabilities: row.capabilities,
  })
}

export async function loadRuntimeUpdateRecipientsRepo(
  remoteAgentId: string,
  executor: Executor = db
) {
  const recipients = await runOn<{
    workspaceId: string
    workspaceMemberId: string
  }>(
    executor,
    `
      SELECT DISTINCT member.workspace_id AS "workspaceId", viewer_subj.workspace_member_id AS "workspaceMemberId"
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
  return recipients.rows
}

export async function appendRuntimeUpdatedSyncEventRepo(
  params: {
    workspaceId: string
    workspaceMemberId: string
    remoteAgentId: string
    snapshot: RemoteAgentRuntimeState
  },
  executor: Executor = db
) {
  await appendWorkspaceMemberSyncEvent(executor, {
    workspaceId: params.workspaceId,
    workspaceMemberId: params.workspaceMemberId,
    eventType: "remote_agent.runtime_updated",
    payload: {
      remoteAgentId: params.remoteAgentId,
      snapshot: params.snapshot,
    },
  })
}

/**
 * Compute `requiresContactApproval` for a joined agent row + assemble the
 * domain record. Keeps the `db`-threading derive call inside the repo.
 */
export async function toRemoteAgentRecordRepo(
  row: RemoteAgentRow,
  executor: Executor = db
) {
  const requiresContactApproval = await deriveRequiresContactApproval(
    executor,
    "remote_agent",
    row.id,
    row.workspaceId
  )
  const record = { ...row, requiresContactApproval }
  return record
}

export async function listRemoteAgentRowsRepo(
  workspaceId: string,
  visibleIds: string[],
  executor: Executor = db
) {
  const result = await runOn<RemoteAgentRow>(
    executor,
    `
      SELECT
        agent.*,
        resource.workspace_id AS "workspaceId",
        resource.display_name AS "displayName",
        owner_subject.workspace_member_id AS "ownerWorkspaceMemberId",
        (resource.status = 'active') AS "isActive",
        binding.machine_id AS "machineId",
        machine.title AS "machineTitle",
        binding.status AS "bindingStatus",
        binding.runtime_path AS "runtimePath",
        binding.local_root_path AS "localRootPath",
        machine.lifecycle_state AS "machineLifecycleState",
        binding.runtime_state AS "runtimeState",
        binding.status_text AS "statusText",
        latest_ctx.latest_runtime_session_id AS "latestRuntimeSessionId",
        latest_ctx.latest_active_conversation_id AS "latestActiveConversationId",
        latest_ctx.latest_active_task_id AS "latestActiveTaskId",
        binding.last_activity_at AS "lastActivityAt",
        latest_ctx.latest_last_run_started_at AS "latestLastRunStartedAt",
        latest_ctx.latest_last_run_finished_at AS "latestLastRunFinishedAt",
        binding.last_error AS "lastError",
        binding.capabilities,
        (
          SELECT COUNT(DISTINCT delivery.conversation_id)
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = agent.id
            AND delivery.status = 'pending'
        ) AS "pendingConversationCount",
        (
          SELECT COUNT(*)
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = agent.id
            AND delivery.status = 'pending'
        ) AS "unreadDeliveryCount"
      FROM remote_agents agent
      INNER JOIN workspace_resources_live resource
        ON resource.id = agent.id
      LEFT JOIN access_subjects owner_subject
        ON owner_subject.id = resource.owner_subject_id
      LEFT JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = agent.id
      LEFT JOIN remote_agent_machines machine
        ON machine.id = binding.machine_id
      ${LATEST_CONVERSATION_CONTEXT_LATERAL}
      WHERE resource.workspace_id = $1
        AND resource.deleted_at IS NULL
        AND agent.id = ANY($2::uuid[])
      ORDER BY agent.created_at DESC, agent.id DESC
    `,
    [workspaceId, visibleIds]
  )
  return result.rows
}

export async function getRemoteAgentRowRepo(
  workspaceId: string,
  remoteAgentId: string,
  executor: Executor = db
) {
  const result = await runOn<RemoteAgentRow>(
    executor,
    `
      SELECT
        agent.*,
        resource.workspace_id AS "workspaceId",
        resource.display_name AS "displayName",
        owner_subject.workspace_member_id AS "ownerWorkspaceMemberId",
        (resource.status = 'active') AS "isActive",
        binding.machine_id AS "machineId",
        machine.title AS "machineTitle",
        binding.status AS "bindingStatus",
        binding.runtime_path AS "runtimePath",
        binding.local_root_path AS "localRootPath",
        machine.lifecycle_state AS "machineLifecycleState",
        binding.runtime_state AS "runtimeState",
        binding.status_text AS "statusText",
        latest_ctx.latest_runtime_session_id AS "latestRuntimeSessionId",
        latest_ctx.latest_active_conversation_id AS "latestActiveConversationId",
        latest_ctx.latest_active_task_id AS "latestActiveTaskId",
        binding.last_activity_at AS "lastActivityAt",
        latest_ctx.latest_last_run_started_at AS "latestLastRunStartedAt",
        latest_ctx.latest_last_run_finished_at AS "latestLastRunFinishedAt",
        binding.last_error AS "lastError",
        binding.capabilities,
        (
          SELECT COUNT(DISTINCT delivery.conversation_id)
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = agent.id
            AND delivery.status = 'pending'
        ) AS "pendingConversationCount",
        (
          SELECT COUNT(*)
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = agent.id
            AND delivery.status = 'pending'
        ) AS "unreadDeliveryCount"
      FROM remote_agents agent
      INNER JOIN workspace_resources_live resource
        ON resource.id = agent.id
      LEFT JOIN access_subjects owner_subject
        ON owner_subject.id = resource.owner_subject_id
      LEFT JOIN remote_agent_bindings binding
        ON binding.remote_agent_id = agent.id
      LEFT JOIN remote_agent_machines machine
        ON machine.id = binding.machine_id
      ${LATEST_CONVERSATION_CONTEXT_LATERAL}
      WHERE resource.workspace_id = $1
        AND resource.deleted_at IS NULL
        AND agent.id = $2
      LIMIT 1
    `,
    [workspaceId, remoteAgentId]
  )
  return result.rows[0] ?? null
}

/**
 * Whole-transaction create of a remote agent: workspace-resource root + detail row
 * + grants are inserted atomically (cross-module storage calls thread the same
 * `client` executor). Returns the raw inserted remote_agents row.
 */
export async function createRemoteAgentTx(params: {
  remoteAgentId: string
  workspaceId: string
  displayName: string
  ownerWorkspaceMemberId: string
  title: string
  description: string | null
  runtimeKind: RemoteAgentRuntimeKind
  avatarFileId: string | null
  avatarEmoji: string | null
  isPublicShared: boolean
  metadata: Record<string, unknown>
  grants: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceResourceGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
}): Promise<RemoteAgentRow> {
  return withDbTransaction(async (client) => {
    await insertWorkspaceResourceRoot(client, {
      id: params.remoteAgentId,
      workspaceId: params.workspaceId,
      kind: "remote_agent",
      displayName: params.displayName,
      ownerWorkspaceMemberId: params.ownerWorkspaceMemberId,
      status: "active",
    })
    const result = await runOn<RemoteAgentRow>(
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
        params.remoteAgentId,
        params.title,
        params.description,
        params.runtimeKind,
        params.avatarFileId,
        params.avatarEmoji,
        params.isPublicShared,
        JSON.stringify(params.metadata),
      ]
    )
    const row = result.rows[0]!
    for (const grant of params.grants) {
      await insertWorkspaceResourceGrant(client, {
        workspaceId: params.workspaceId,
        workspaceResourceId: row.id,
        target: grant.target,
        permissions: grant.permissions,
        conversationTypeMaskOverride:
          grant.conversationTypeMaskOverride ?? null,
        createdByWorkspaceMemberId: params.ownerWorkspaceMemberId,
        reason: grant.reason ?? null,
      } satisfies InsertWorkspaceResourceGrantInput)
    }
    return row
  })
}

export async function updateRemoteAgentRowRepo(
  params: {
    workspaceId: string
    remoteAgentId: string
    title: string
    description: string | null
    avatarFileId: string | null
    avatarEmoji: string | null
    isPublicShared: boolean
    metadata: Record<string, unknown>
  },
  executor: Executor = db
) {
  await runOn(
    executor,
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
          FROM workspace_resources_live resource
          WHERE resource.id = remote_agents.id
            AND resource.workspace_id = $1
            AND resource.deleted_at IS NULL
        )
      RETURNING *
    `,
    [
      params.workspaceId,
      params.remoteAgentId,
      params.title,
      params.description,
      params.avatarFileId,
      params.avatarEmoji,
      params.isPublicShared,
      JSON.stringify(params.metadata),
    ]
  )
}

export async function createMachinePairingRepo(
  params: {
    workspaceId: string
    title: string
    description: string | null
    apiKeyHash: string
    createdByWorkspaceMemberId: string
  },
  executor: Executor = db
) {
  const result = await runBuilder(
    executor,
    executor
      .insertInto("remoteAgentMachines")
      .values({
        workspaceId: params.workspaceId,
        title: params.title,
        description: params.description,
        apiKeyHash: params.apiKeyHash,
        trustStatus: "active",
        createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
        createdAt: sql`NOW()`,
      })
      .returningAll()
  )
  return result.rows[0]!
}

export async function listRemoteAgentMachinesRepo(
  workspaceId: string,
  executor: Executor = db
) {
  const result = await runOn<MachineListRecord>(
    executor,
    `
      SELECT
        machine.*,
        (
          SELECT COUNT(*)
          FROM remote_agent_bindings binding
          WHERE binding.machine_id = machine.id
            AND binding.status = 'active'
        ) AS "bindingCount"
      FROM remote_agent_machines machine
      WHERE machine.workspace_id = $1
      ORDER BY machine.created_at DESC
    `,
    [workspaceId]
  )
  return result.rows
}

export async function getRemoteAgentMachineDetailRepo(
  params: { workspaceId: string; machineId: string },
  executor: Executor = db
) {
  const [machineResult, catalogResult, bindingResult] = await Promise.all([
    runBuilder(
      executor,
      executor
        .selectFrom("remoteAgentMachines")
        .selectAll()
        .where("workspaceId", "=", params.workspaceId)
        .where("id", "=", params.machineId)
        .limit(1)
    ),
    runBuilder(
      executor,
      executor
        .selectFrom("remoteAgentRuntimeCatalog")
        .selectAll()
        .where("machineId", "=", params.machineId)
        .orderBy("runtimeKind", "asc")
    ),
    runOn<MachineBindingRecord>(
      executor,
      `
        SELECT
          binding.remote_agent_id AS "remoteAgentId",
          binding.runtime_kind AS "runtimeKind",
          binding.runtime_path AS "runtimePath",
          binding.local_root_path AS "localRootPath",
          binding.status,
          binding.runtime_state AS "runtimeState",
          binding.status_text AS "statusText",
          latest_ctx.latest_runtime_session_id AS "latestRuntimeSessionId",
          latest_ctx.latest_active_conversation_id AS "latestActiveConversationId",
          latest_ctx.latest_active_task_id AS "latestActiveTaskId",
          binding.last_activity_at AS "lastActivityAt",
          latest_ctx.latest_last_run_started_at AS "latestLastRunStartedAt",
          latest_ctx.latest_last_run_finished_at AS "latestLastRunFinishedAt",
          binding.last_error AS "lastError",
          binding.capabilities,
          resource.display_name AS "displayName",
          (
            SELECT COUNT(DISTINCT delivery.conversation_id)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
          ) AS "pendingConversationCount",
          (
            SELECT COUNT(*)
            FROM remote_agent_message_deliveries delivery
            WHERE delivery.remote_agent_id = binding.remote_agent_id
              AND delivery.status = 'pending'
          ) AS "unreadDeliveryCount"
        FROM remote_agent_bindings binding
        INNER JOIN remote_agents agent ON agent.id = binding.remote_agent_id
        INNER JOIN workspace_resources_live resource ON resource.id = agent.id
        ${LATEST_CONVERSATION_CONTEXT_LATERAL}
        WHERE binding.machine_id = $1
        ORDER BY agent.created_at DESC
      `,
      [params.machineId]
    ),
  ])

  return {
    machine: machineResult.rows[0] ?? null,
    runtimeCatalog: catalogResult.rows,
    bindings: bindingResult.rows,
  }
}

export async function loadMachineIdForBindCheckRepo(
  params: { workspaceId: string; machineId: string },
  executor: Executor = db
) {
  const result = await runBuilder(
    executor,
    executor
      .selectFrom("remoteAgentMachines")
      .select("id")
      .where("workspaceId", "=", params.workspaceId)
      .where("id", "=", params.machineId)
      .limit(1)
  )
  return result.rows[0] ?? null
}

export async function loadRuntimeCatalogEntryForBindRepo(
  params: { machineId: string; runtimeKind: RemoteAgentRuntimeKind },
  executor: Executor = db
) {
  const result = await runBuilder(
    executor,
    executor
      .selectFrom("remoteAgentRuntimeCatalog")
      .select(["executablePath", "status", "lastError"])
      .where("machineId", "=", params.machineId)
      .where("runtimeKind", "=", params.runtimeKind)
      .limit(1)
  )
  return result.rows[0] ?? null
}

export async function upsertBindingRepo(
  params: {
    remoteAgentId: string
    machineId: string
    runtimeKind: RemoteAgentRuntimeKind
    runtimePath: string | null
    localRootPath: string | null
  },
  executor: Executor = db
) {
  await executor
    .insertInto("remoteAgentBindings")
    .values({
      remoteAgentId: params.remoteAgentId,
      machineId: params.machineId,
      runtimeKind: params.runtimeKind,
      runtimePath: params.runtimePath,
      localRootPath: params.localRootPath,
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
}

export async function listGroupTaskGrantsRepo(
  remoteAgentId: string,
  executor: Executor = db
) {
  const result = await runOn<{
    workspaceMemberId: string
    createdByWorkspaceMemberId: string | null
    createdAt: Date
    updatedAt: Date
    userId: string
    userName: string | null
    userAvatarFileId: string | null
  }>(
    executor,
    `
      SELECT
        grant_row.workspace_member_id AS "workspaceMemberId",
        grant_row.created_by_workspace_member_id AS "createdByWorkspaceMemberId",
        grant_row.created_at AS "createdAt",
        grant_row.updated_at AS "updatedAt",
        wm.user_id AS "userId",
        u.name AS "userName",
        u.avatar_file_id AS "userAvatarFileId"
      FROM remote_agent_group_task_grants grant_row
      INNER JOIN workspace_members wm ON wm.id = grant_row.workspace_member_id
      INNER JOIN users u ON u.id = wm.user_id
      WHERE grant_row.remote_agent_id = $1
      ORDER BY grant_row.created_at ASC
    `,
    [remoteAgentId]
  )
  return result.rows
}

export async function loadValidWorkspaceMemberIdsRepo(
  workspaceId: string,
  memberIds: string[],
  executor: Executor = db
): Promise<string[]> {
  const membership = await runBuilder(
    executor,
    executor
      .selectFrom("workspaceMembers")
      .select("id")
      .where("workspaceId", "=", workspaceId)
      .where("id", "in", memberIds)
  )
  return membership.rows.map((row) => row.id)
}

/**
 * Whole-transaction set-replace of a remote agent's group-task grants: the
 * SECURITY DEFINER `sd_replace_remote_agent_group_grants` clears the derived
 * table, then the new grant rows are inserted — all in one transaction so the
 * replace is atomic.
 */
export async function replaceGroupTaskGrantsTx(params: {
  remoteAgentId: string
  createdByWorkspaceMemberId: string
  workspaceMemberIds: string[]
}) {
  await withDbTransaction(async (client) => {
    // set-replace of a derived grants table → SECURITY DEFINER fn (§7.5).
    await sql`SELECT sd_replace_remote_agent_group_grants(${params.remoteAgentId}::uuid)`.execute(
      client
    )
    for (const workspaceMemberId of params.workspaceMemberIds) {
      await client
        .insertInto("remoteAgentGroupTaskGrants")
        .values({
          remoteAgentId: params.remoteAgentId,
          workspaceMemberId: workspaceMemberId,
          createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
          createdAt: sql`NOW()`,
        })
        .execute()
    }
  })
}

export async function loadDeliveryTargetParticipantsRepo(
  params: {
    conversationId: string
    authorParticipantId: string | null
    itemId: string
  },
  executor: Executor = db
) {
  const participants = await runOn<{
    participantId: string
    remoteAgentId: string
  }>(
    executor,
    `
      SELECT
        cp.id AS "participantId",
        cpsubj.remote_agent_id AS "remoteAgentId"
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
    [params.conversationId, params.authorParticipantId, params.itemId]
  )
  return participants.rows
}

export async function insertDeliveryForParticipantRepo(
  params: {
    remoteAgentId: string
    conversationId: string
    itemId: string
  },
  executor: Executor = db
) {
  const inserted = await runBuilder(
    executor,
    executor
      .insertInto("remoteAgentMessageDeliveries")
      .values({
        remoteAgentId: params.remoteAgentId,
        conversationId: params.conversationId,
        itemId: params.itemId,
        status: "pending",
        attempts: 0,
        // Capture the enqueuing request's W3C trace so a later reconnect-replay
        // or retry-worker send (neither of which has an active request span) can
        // still carry the originating trace to the daemon. NULL when tracing off.
        originTraceparent: activeTraceparent() ?? null,
        createdAt: sql`NOW()`,
      })
      .onConflict((oc) => oc.columns(["remoteAgentId", "itemId"]).doNothing())
  )

  if ((inserted.rowCount ?? 0) > 0) {
    await executor
      .insertInto("remoteAgentConversationViews")
      .values({
        remoteAgentId: params.remoteAgentId,
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

export async function listRemoteAgentConversationsRepo(
  remoteAgentId: string,
  executor: Executor = db
) {
  const result = await runOn(
    executor,
    `
      SELECT
        c.id,
        c.kind,
        EXISTS (
          SELECT 1 FROM conversation_transport_bindings b
          WHERE b.conversation_id = c.id
        ) AS "isIm",
        c.title,
        c.updated_at AS "updatedAt",
        view.unread_count AS "unreadCount"
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
    [remoteAgentId]
  )
  return result.rows
}

export async function checkRemoteAgentMessagesRepo(
  params: {
    remoteAgentId: string
    limit: number
    conversationId?: string
  },
  executor: Executor = db
) {
  const values: unknown[] = [params.remoteAgentId, params.limit]
  let conversationFilter = ""
  if (params.conversationId) {
    values.push(params.conversationId)
    conversationFilter = ` AND delivery.conversation_id = $${values.length}::uuid`
  }
  const result = await runOn<{
    id: string
    remoteAgentId: string
    conversationId: string
    itemId: string
    status: string
    createdAt: Date
    sequence: string | number
  }>(
    executor,
    `
      SELECT
        delivery.id,
        delivery.remote_agent_id AS "remoteAgentId",
        delivery.conversation_id AS "conversationId",
        delivery.item_id AS "itemId",
        delivery.status,
        delivery.created_at AS "createdAt",
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
  return result.rows
}

export async function loadDeliveriesToCompleteRepo(
  params: { remoteAgentId: string; uniqueIds: string[] },
  executor: Executor = db
) {
  const rows = await runOn<{
    id: string
    conversationId: string
    itemId: string
    sequence: string | number
  }>(
    executor,
    `
      SELECT
        delivery.id,
        delivery.conversation_id AS "conversationId",
        delivery.item_id AS "itemId",
        item.sequence
      FROM remote_agent_message_deliveries delivery
      INNER JOIN conversation_items item ON item.id = delivery.item_id
      WHERE delivery.remote_agent_id = $1
        AND delivery.id = ANY($2::uuid[])
    `,
    [params.remoteAgentId, params.uniqueIds]
  )
  return rows.rows
}

export async function markDeliveriesCompletedRepo(
  params: { remoteAgentId: string; uniqueIds: string[] },
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentMessageDeliveries")
    .set({
      status: "completed",
      lastAckedAt: sql`NOW()`,
    })
    .where("remoteAgentId", "=", params.remoteAgentId)
    .where("id", "in", params.uniqueIds)
    .execute()
}

export async function upsertConversationViewReadStateRepo(
  params: {
    remoteAgentId: string
    conversationId: string
    itemId: string
    sequence: number
  },
  executor: Executor = db
) {
  await runOn(
    executor,
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
    [
      params.remoteAgentId,
      params.conversationId,
      params.itemId,
      params.sequence,
    ]
  )
}

export async function searchRemoteAgentMessagesRepo(
  params: {
    conversationId: string
    queryLike: string
    participantId: string
    limit: number
  },
  executor: Executor = db
) {
  const result = await runOn<{
    id: string
    sequence: string | number
  }>(
    executor,
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
      params.queryLike,
      params.participantId,
      params.limit,
    ]
  )
  return result.rows
}

export async function loadActiveBindingMachineIdRepo(
  remoteAgentId: string,
  executor: Executor = db
): Promise<string | null> {
  const binding = await runBuilder(
    executor,
    executor
      .selectFrom("remoteAgentBindings")
      .select("machineId")
      .where("remoteAgentId", "=", remoteAgentId)
      .where("status", "=", "active")
      .limit(1)
  )
  return binding.rows[0]?.machineId ?? null
}

export async function closeMachineSessionRepo(
  params: { sessionId: string; closeReason: string | null },
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentMachineSessions")
    .set({
      status: "closed",
      closeReason: sql`COALESCE(${params.closeReason}, close_reason)`,
      endedAt: sql`NOW()`,
    })
    .where("id", "=", params.sessionId)
    .where("status", "!=", "closed")
    .execute()
}

export async function offlineBindingsForMachineRepo(
  params: { remoteAgentId: string; statusText: string },
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentBindings")
    .set({
      runtimeState: "offline",
      statusText: params.statusText,
    })
    .where("remoteAgentId", "=", params.remoteAgentId)
    .execute()
  await executor
    .updateTable("remoteAgentConversationContexts")
    .set({
      runtimeState: "offline",
      statusText: params.statusText,
      lastRunFinishedAt: sql`COALESCE(last_run_finished_at, NOW())`,
    })
    .where("remoteAgentId", "=", params.remoteAgentId)
    .where("runtimeState", "in", [
      "running",
      "waiting_user_input",
      "plan_drafting",
      "waiting_plan_approval",
    ])
    .execute()
}

export async function closeSupersededMachineSessionRepo(
  sessionId: string,
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentMachineSessions")
    .set({
      status: "closed",
      closeReason: "superseded by newer connection",
      endedAt: sql`NOW()`,
    })
    .where("id", "=", sessionId)
    .where("status", "!=", "closed")
    .execute()
}

export async function closeExistingMachineSessionsRepo(
  machineId: string,
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentMachineSessions")
    .set({
      status: "closed",
      closeReason: sql`COALESCE(close_reason, 'superseded by newer connection')`,
      endedAt: sql`NOW()`,
    })
    .where("machineId", "=", machineId)
    .where("status", "in", ["connecting", "active"])
    .execute()
}

export async function insertMachineSessionRepo(
  params: { machineId: string; remoteAddr: string | null },
  executor: Executor = db
) {
  const sessionResult = await runBuilder(
    executor,
    executor
      .insertInto("remoteAgentMachineSessions")
      .values({
        machineId: params.machineId,
        status: "connecting",
        transport: "websocket",
        remoteAddr: params.remoteAddr,
        lastHeartbeatAt: sql`NOW()`,
        startedAt: sql`NOW()`,
        createdAt: sql`NOW()`,
      })
      .returning(["id", "fencingToken"])
  )
  return sessionResult.rows[0]!
}

export async function heartbeatMachineSessionRepo(
  sessionId: string,
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentMachineSessions")
    .set({
      lastHeartbeatAt: sql`NOW()`,
    })
    .where("id", "=", sessionId)
    .execute()
}

export async function markMachineSessionActiveRepo(
  sessionId: string,
  executor: Executor = db
) {
  await executor
    .updateTable("remoteAgentMachineSessions")
    .set({
      status: "active",
      lastHeartbeatAt: sql`NOW()`,
    })
    .where("id", "=", sessionId)
    .execute()
}

/**
 * Default-db-bound wrapper around the workspace-resources root update so the
 * service can adjust an agent's workspace-resource root (display name / status /
 * soft-delete) without importing the db client. The underlying storage fn stays
 * executor-injectable for transactional callers.
 */
export async function updateWorkspaceResourceRootDefault(input: {
  id: string
  displayName?: string
  ownerWorkspaceMemberId?: string | null
  status?: WorkspaceResourceStatus
  conversationTypeMaskOverride?: number | null
  deletedAt?: Date | null
}) {
  await updateWorkspaceResourceRoot(db, input)
}
