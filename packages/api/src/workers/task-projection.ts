/**
 * Task-projection worker (G5 / Stage 8).
 *
 * Consumes `tool_call_task_transport_projections(status='pending')` rows
 * (inserted by `createRuntimeAuthorizationTaskRequest`) and
 * materializes them into transport_message_links so a supporting
 * connector can render the task as an IM message + keyboard.
 *
 * v1: QQ only (long_connection → keyboard; webhook+confirmed →
 * fallback text). Feishu / Weixin / Wecom bindings get
 * `status='skipped' error='not_supported_in_v1'`.
 *
 * Branch order (must stay strict — first match wins):
 *   1. no binding                     → skipped, error='no_binding'
 *   2. binding.transportKind!=='qq'   → skipped, error='not_supported_in_v1'
 *   3. QQ webhook + !webhookInboundConfirmed
 *                                     → skipped, error='webhook_inbound_unavailable'
 *   4. account inactive or outbound disabled
 *                                     → skipped, error='outbound_disabled'
 *   5. QQ webhook + confirmed         → fallback text item + link
 *   6. QQ long_connection             → keyboard item + link
 *
 * Each row is processed in one outer tx that takes `FOR UPDATE SKIP
 * LOCKED` so multiple worker replicas don't double-project. Business
 * work (mint tokens, create item, persist link) runs inside a
 * SAVEPOINT — if any step throws, we ROLLBACK TO SAVEPOINT, advance
 * `attempts++` + `next_attempt_at = NOW()+backoff` in the outer tx,
 * and COMMIT. Successful runs flip status to `projected` and queue
 * delivery AFTER the tx commits.
 */

import { CompiledQuery, sql } from "kysely"
import {
  TASK_REQUEST_KIND,
  type RuntimeAuthorizationPreset,
} from "@synapse/shared"
import {
  db,
  withDbTransaction,
  type Executor,
} from "../infrastructure/database/kysely.js"
import { parseInstantString } from "../infrastructure/datetime.js"
import {
  mintActionToken,
  sweepExpiredActionTokens,
  type ActionTokenPayload,
} from "../modules/tasks/action-tokens.js"
import { getTaskSummary } from "../modules/tasks/service.js"
import {
  createConversationItem,
  type ConversationItemPartInput,
} from "../modules/chat/service.js"
import {
  enqueueOutboundDelivery,
  persistOutboundLinkRowRaw,
} from "../modules/im/service/delivery-links.js"
import { getConversationTransportBinding } from "../modules/im/service.js"
import { encodeForConversationItem } from "../modules/im/messaging/canonical-encoding.js"
import { tryGetConnector } from "../modules/im/connectors/registry.js"
import {
  CANONICAL_MESSAGE_SCHEMA_VERSION,
  type CanonicalMessage,
  type CanonicalPart,
} from "../modules/im/messaging/canonical-message.js"
import { createLogger } from "../infrastructure/logger/index.js"

const log = createLogger("task-projection")

const TICK_INTERVAL_MS = 5_000
const BATCH_SIZE = 10
const MAX_ATTEMPTS = 5
const TOKEN_SWEEP_EVERY_TICKS = 60 // ≈ every 5 min

/** Run raw SQL (text+params) on the transaction/db executor. */
async function runOn<T = any>(
  executor: Executor,
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  const result = await executor.executeQuery<T>(
    CompiledQuery.raw(text, [...params])
  )
  return { rows: result.rows as T[] }
}

/**
 * Why this list and not a more general gate: the projection layer is the
 * ONLY place that has to know about transport-specific gating — every
 * other layer (canonical-encoding, render, outbound) is generic. The
 * eligibility decision now goes through two polymorphic checks
 * (`messageCapabilities.supportsInteractionPrompt` + connector's
 * optional `getTaskProjectionReadiness?()` hook), so adding a
 * new connector with task-prompt support requires zero edits
 * here.
 */

const FALLBACK_TEXT_DEFAULT = "需要审批，请回到 Synapse dashboard 处理"

interface PendingRow {
  id: string
  task_id: string
  workspace_id: string
  conversation_id: string
  transport_message_link_id: string | null
  attempts: number
}

interface ProjectionTickStats {
  picked: number
  projected: number
  skipped: number
  failed: number
  errors: number
}

interface WorkerHandle {
  stop(): Promise<void>
}

let active: WorkerHandle | null = null
let tickCounter = 0

/**
 * Start the projection worker. Returns a stop handle. Safe to call
 * multiple times — the second call is a no-op (the first stop()
 * removes the handle).
 */
export function startTaskProjectionWorker(): WorkerHandle {
  if (active) return active
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  const tick = async () => {
    if (stopped) return
    try {
      const stats = await runOneTick()
      if (stats.errors > 0) {
        log.warn({ stats }, "tick had errors")
      }
      tickCounter += 1
      if (tickCounter % TOKEN_SWEEP_EVERY_TICKS === 0) {
        await sweepExpiredActionTokens().catch((err) => {
          log.warn({ err }, "token sweep failed")
        })
      }
    } catch (err) {
      log.warn({ err }, "tick crashed")
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, TICK_INTERVAL_MS)
        timer.unref?.()
      }
    }
  }

  // Kick off immediately + schedule recurring.
  setTimeout(tick, 0).unref?.()

  const handle: WorkerHandle = {
    async stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
  active = handle
  return handle
}

export async function stopTaskProjectionWorker(): Promise<void> {
  if (!active) return
  await active.stop()
  active = null
}

export async function runOneTick(): Promise<ProjectionTickStats> {
  const stats: ProjectionTickStats = {
    picked: 0,
    projected: 0,
    skipped: 0,
    failed: 0,
    errors: 0,
  }

  // Link IDs to enqueue AFTER the outer tx commits — queueMicrotask is
  // not safe here because a microtask scheduled inside a Promise body
  // can fire before the wrapping `transaction(...)` resolves the COMMIT
  // round-trip, leaving the BullMQ worker to read a not-yet-visible row.
  const linkIdsToEnqueue: string[] = []

  // One outer tx per batch; FOR UPDATE SKIP LOCKED gives us isolation
  // across worker replicas.
  await withDbTransaction(async (client) => {
    const result = await runOn<PendingRow>(
      client,
      `
        SELECT id, task_id, workspace_id, conversation_id,
               transport_message_link_id, attempts
        FROM tool_call_task_transport_projections
        WHERE status = 'pending' AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [BATCH_SIZE]
    )
    stats.picked = result.rows.length
    for (const row of result.rows) {
      try {
        const outcome = await processOne(client, row, linkIdsToEnqueue)
        if (outcome === "projected") stats.projected += 1
        else if (outcome === "skipped") stats.skipped += 1
        else if (outcome === "failed") stats.failed += 1
      } catch (err) {
        // Any throw from processOne is a bug, since processOne is
        // supposed to convert all errors into a state update inside its
        // savepoint. Surface it but don't break the rest of the batch.
        stats.errors += 1
        log.error({ err, rowId: row.id }, "processOne unexpected throw")
        // Best-effort bump attempts so we don't get stuck on a poison row.
        await bumpAttemptsOnRow(client, row, errorMessage(err)).catch(
          () => undefined
        )
      }
    }
  })

  // Now that the outer tx is committed, enqueue every collected linkId.
  // Doing this here (instead of via queueMicrotask inside the tx) is the
  // only ordering that guarantees the link row is visible to the BullMQ
  // worker by the time the job runs.
  for (const linkId of linkIdsToEnqueue) {
    try {
      await enqueueOutboundDelivery(linkId)
    } catch (err) {
      log.warn({ err, linkId }, "post-commit enqueue failed")
    }
  }

  return stats
}

/**
 * Process one projection row. Returns the terminal outcome — caller
 * tallies stats; we own the row's final state-update inside the same
 * outer tx.
 *
 * `linkIdsToEnqueue` is appended to when this row produces (or rebinds
 * to) a deliverable link. The caller flushes the array AFTER the outer
 * transaction commits, since BullMQ jobs scheduled before commit can be
 * picked up by the worker before the link row is visible.
 */
async function processOne(
  client: Executor,
  row: PendingRow,
  linkIdsToEnqueue: string[]
): Promise<"projected" | "skipped" | "failed"> {
  // Idempotence: if a previous run wrote a link, just enqueue and mark
  // projected. Don't rebuild item/link/token.
  if (row.transport_message_link_id) {
    await markRowProjected(client, row.id, row.transport_message_link_id)
    linkIdsToEnqueue.push(row.transport_message_link_id)
    return "projected"
  }

  // Verify the task is still pending + not expired.
  const lockedTask = await runOn<{
    id: string
    status: string
    expires_at: Date | null
  }>(
    client,
    `
      SELECT id, lifecycle_status AS status, expires_at
      FROM tool_call_tasks
      WHERE id = $1
      FOR UPDATE
    `,
    [row.task_id]
  )
  const lock = lockedTask.rows[0]
  if (!lock) {
    await skipRow(client, row.id, "task_missing")
    return "skipped"
  }
  if (
    lock.status !== "working" &&
    lock.status !== "input_required" &&
    lock.status !== "auth_required" &&
    lock.status !== "submitted"
  ) {
    await skipRow(client, row.id, "task_already_resolved_or_expired")
    return "skipped"
  }
  if (lock.expires_at) {
    if (lock.expires_at.getTime() < Date.now()) {
      await skipRow(client, row.id, "task_already_resolved_or_expired")
      return "skipped"
    }
  }

  // Strict-order branch resolution per plan (G5 §"跨 IM 行为规避"):
  //   1. no_binding
  //   2. not_supported_in_v1            (binding.transportKind !∈ allowed)
  //   3. webhook_inbound_unavailable    (QQ webhook + !webhookInboundConfirmed)
  //   4. outbound_disabled              (account inactive OR outbound off)
  //   5. fallback / keyboard delivery
  //
  // We load the binding directly here (rather than going through
  // `resolveBindingForOutbound`) so the QQ webhook gate at step 3 can
  // fire even when outbound is disabled — without this ordering, every
  // unconfirmed-webhook account would be reported as the more generic
  // `outbound_disabled`, and the recovery hook for
  // `webhook_inbound_unavailable` would never see anything to re-arm.
  const binding = await getConversationTransportBinding({
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
  })
  if (!binding) {
    await skipRow(client, row.id, "no_binding")
    return "skipped"
  }
  // Eligibility goes through capability + per-account readiness hook:
  //   (a) Generic capability: connector must declare it can render
  //       task prompts at all.
  //   (b) Per-account precondition (e.g. QQ webhook requires the
  //       operator's OQ2 confirmation). Failure stamps `error` so
  //       `service/recovery.ts` recovery code can re-arm when the
  //       precondition flips.
  const connector = tryGetConnector(binding.transportKind)
  if (!connector?.messageCapabilities.supportsInteractionPrompt) {
    await skipRow(client, row.id, "not_supported_in_v1")
    return "skipped"
  }

  const account = binding.account
  const readiness = connector.getTaskProjectionReadiness?.(account) ?? {
    ok: true,
  }
  if (!readiness.ok) {
    await skipRow(client, row.id, readiness.reason)
    return "skipped"
  }

  if (account.status !== "active" || !binding.outboundEnabled) {
    await skipRow(client, row.id, "outbound_disabled")
    return "skipped"
  }

  // Load the full task summary so we know what grant options /
  // presets to mint tokens for.
  const task = await getTaskSummary(row.task_id, client)
  if (!task || task.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION) {
    await skipRow(client, row.id, "task_unsupported_kind")
    return "skipped"
  }

  // Business work inside a savepoint so partial failures don't leak
  // orphan items/links into the outer tx.
  //
  // Fallback-text mode is used when the destination cannot render an
  // inline keyboard right now (e.g. QQ webhook accounts before the
  // first inbound anchors the connection; long_connection accounts
  // use the keyboard path). Detected via the same readiness hook the
  // eligibility check above used — a special-case readiness with a
  // marker reason for "render the prompt as text". For now any
  // webhook-mode account uses the fallback path.
  const useFallbackText = account.connectionMode === "webhook"
  let projectionLinkId: string | null = null
  let savepointFailed = false
  let savepointError: string | null = null
  try {
    await runOn(client, "SAVEPOINT projection_business", [])
    const mintedOptions = await mintOptionsAndTokens(client, {
      taskId: task.id,
      taskExpiresAt: task.expiresAt ? parseInstantString(task.expiresAt) : null,
      presets:
        task.runtimeAuthorization?.availablePresets ??
        (["once"] as RuntimeAuthorizationPreset[]),
      grantOptions: task.runtimeAuthorization?.grantOptions ?? [],
    })
    const fallbackText = buildFallbackText({
      task,
    })
    const message: CanonicalMessage = useFallbackText
      ? buildFallbackCanonical(fallbackText)
      : buildKeyboardCanonical({
          taskId: task.id,
          title: task.runtimeAuthorization?.deviceDisplayName
            ? `${task.runtimeAuthorization.deviceDisplayName} 请求授权`
            : "需要审批",
          fallbackText,
          options: mintedOptions,
        })
    const encoded = encodeForConversationItem(message)
    const item = await createConversationItem({
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      scope: "shared",
      surface: "internal",
      itemType: "message",
      subtype: "system",
      role: "system",
      metadata: { transport: encoded.transportMetadata },
      parts: buildItemParts(message),
      queryable: client,
    })
    const persisted = await persistOutboundLinkRowRaw({
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      itemId: item.id,
      transportAccountId: binding.account.id,
      transportEndpointId: binding.endpoint.id,
      transportKind: binding.transportKind,
    })
    await markRowProjected(client, row.id, persisted.id)
    projectionLinkId = persisted.id
    await runOn(client, "RELEASE SAVEPOINT projection_business", [])
  } catch (err) {
    savepointFailed = true
    savepointError = errorMessage(err)
    await runOn(client, "ROLLBACK TO SAVEPOINT projection_business", []).catch(
      () => undefined
    )
    await runOn(client, "RELEASE SAVEPOINT projection_business", []).catch(
      () => undefined
    )
  }

  if (savepointFailed) {
    await bumpAttemptsOnRow(client, row, savepointError ?? "savepoint_failed")
    return row.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "skipped"
  }

  // Outer tx commits after this function returns; the caller flushes
  // `linkIdsToEnqueue` post-commit so the BullMQ worker doesn't race
  // ahead of the link row's visibility.
  if (projectionLinkId) {
    linkIdsToEnqueue.push(projectionLinkId)
  }
  return "projected"
}

async function markRowProjected(
  client: Executor,
  rowId: string,
  linkId: string
): Promise<void> {
  await runOn(
    client,
    `
      UPDATE tool_call_task_transport_projections
      SET status = 'projected',
          transport_message_link_id = $2,
          error = NULL,
          updated_at = NOW()
      WHERE id = $1
    `,
    [rowId, linkId]
  )
}

async function skipRow(
  client: Executor,
  rowId: string,
  error: string
): Promise<void> {
  await runOn(
    client,
    `
      UPDATE tool_call_task_transport_projections
      SET status = 'skipped',
          error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [rowId, error]
  )
}

async function bumpAttemptsOnRow(
  client: Executor,
  row: PendingRow,
  error: string
): Promise<void> {
  const nextAttempts = row.attempts + 1
  if (nextAttempts >= MAX_ATTEMPTS) {
    await runOn(
      client,
      `
        UPDATE tool_call_task_transport_projections
        SET status = 'failed',
            attempts = $2,
            error = $3,
            updated_at = NOW()
        WHERE id = $1
      `,
      [row.id, nextAttempts, error]
    )
    return
  }
  // Exponential backoff: 5s, 30s, 2min, 10min, 30min
  const backoffSeconds = [5, 30, 120, 600, 1800][Math.min(nextAttempts - 1, 4)]
  await runOn(
    client,
    `
      UPDATE tool_call_task_transport_projections
      SET attempts = $2,
          next_attempt_at = NOW() + ($3 || ' seconds')::interval,
          error = $4,
          updated_at = NOW()
      WHERE id = $1
    `,
    [row.id, nextAttempts, String(backoffSeconds), error]
  )
}

interface MintedOption {
  id: string
  label: string
  actionToken: string
  style?: "primary" | "danger" | "default"
  decision: string
  preset?: string
  selectedGrantOptionId?: string
}

/**
 * Build the option set we present in the keyboard. v1 mints a minimal
 * three-button layout: "Allow once" / "Deny" + (if multi-grant) the
 * grant-option labels. Each button gets its own action token (the
 * decoder uses the token to recover the full payload server-side).
 */
async function mintOptionsAndTokens(
  client: Executor,
  params: {
    taskId: string
    taskExpiresAt?: Date | null
    presets: readonly RuntimeAuthorizationPreset[]
    grantOptions: ReadonlyArray<{ id: string; summary: string }>
  }
): Promise<MintedOption[]> {
  const minted: MintedOption[] = []
  // Pick a default grant option if multiple exist; we currently mint one
  // button per (preset × grant_option) pair, capped to keep the keyboard
  // ≤5 buttons.
  const grantOption = params.grantOptions[0]
  const presetsToShow = params.presets.length > 0 ? params.presets : ["once"]
  const presetLabels: Record<string, string> = {
    once: "仅本次允许",
    actor: "本会话期间允许",
    conversation: "本会话期间允许",
    remote_agent: "对此 Agent 始终允许",
    workspace: "工作区内始终允许",
  }
  for (const preset of presetsToShow) {
    if (minted.length >= 4) break // leave room for the deny button
    const decisionLabel = presetLabels[preset] ?? preset
    const token = await mintActionToken(client, {
      taskId: params.taskId,
      taskExpiresAt: params.taskExpiresAt,
      payload: {
        decision: "approve",
        preset,
        selectedGrantOptionId: grantOption?.id,
      } as ActionTokenPayload,
    })
    minted.push({
      id: `approve-${preset}`,
      label: `✅ ${decisionLabel}`,
      actionToken: token.token,
      style: "primary",
      decision: "approve",
      preset,
      selectedGrantOptionId: grantOption?.id,
    })
  }
  const denyToken = await mintActionToken(client, {
    taskId: params.taskId,
    taskExpiresAt: params.taskExpiresAt,
    payload: { decision: "reject" } as ActionTokenPayload,
  })
  minted.push({
    id: "deny",
    label: "❌ 拒绝",
    actionToken: denyToken.token,
    style: "danger",
    decision: "reject",
  })
  return minted
}

function buildKeyboardCanonical(params: {
  taskId: string
  title: string
  fallbackText: string
  options: MintedOption[]
}): CanonicalMessage {
  const part: CanonicalPart = {
    type: "interaction_prompt",
    taskId: params.taskId,
    title: params.title,
    fallbackText: params.fallbackText,
    options: params.options.map((o) => ({
      id: o.id,
      label: o.label,
      actionToken: o.actionToken,
      style: o.style,
    })),
  }
  return {
    schemaVersion: CANONICAL_MESSAGE_SCHEMA_VERSION,
    plainText: params.fallbackText,
    parts: [part],
  }
}

function buildFallbackCanonical(text: string): CanonicalMessage {
  return {
    schemaVersion: CANONICAL_MESSAGE_SCHEMA_VERSION,
    plainText: text,
    parts: [{ type: "text", text }],
  }
}

function buildItemParts(msg: CanonicalMessage): ConversationItemPartInput[] {
  const parts: ConversationItemPartInput[] = []
  let textBuf = ""
  for (const part of msg.parts) {
    if (part.type === "text") textBuf += (textBuf ? "\n" : "") + part.text
    else if (part.type === "interaction_prompt") {
      // chat layer only accepts text/file_ref/json — represent the
      // prompt as text (plus the structured payload survives in
      // metadata.transport.canonicalParts via encodeForConversationItem).
      textBuf +=
        (textBuf ? "\n" : "") +
        (part.title ? `${part.title}\n${part.fallbackText}` : part.fallbackText)
    }
  }
  if (textBuf) parts.push({ type: "text", text: textBuf })
  return parts
}

function buildFallbackText(params: {
  task: { runtimeAuthorization?: { deviceDisplayName?: string } }
}): string {
  const device = params.task.runtimeAuthorization?.deviceDisplayName
  if (device) {
    return `${device} 请求授权 — ${FALLBACK_TEXT_DEFAULT}`
  }
  return FALLBACK_TEXT_DEFAULT
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// re-exports for tests
export const __testing__ = {
  buildFallbackText,
  buildItemParts,
  buildFallbackCanonical,
  buildKeyboardCanonical,
}
