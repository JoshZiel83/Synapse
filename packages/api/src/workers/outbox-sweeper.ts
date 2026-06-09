/**
 * Outbox sweeper (G7) + shared "enqueue or retry an existing job" helper
 * for transport_message_links delivery.
 *
 * Why it exists:
 *   - BullMQ retries (5 attempts × exponential backoff) cover the common
 *     case of a single failed POST. But there are two failure modes the
 *     retry chain alone can't recover from:
 *       (a) the worker enqueued the job before the link row was visible
 *           (early commit + worker pickup race; the worker returns "missing
 *           link" → job goes to `completed` with no useful work done, the
 *           link is stuck `pending`).
 *       (b) the connector classified a previous attempt as `unknown` /
 *           `unknown_assumed` (QQ's crash-recovery markers — see G6). Even
 *           after BullMQ runs out of attempts, the link should keep trying
 *           via fresh jobs because the duplicate-ambiguous path may still
 *           recover delivery if the platform did receive the payload.
 *   - Recovery hooks (G5: `recoverSkippedProjectionsForRecoveryEvent`) need
 *     the same "enqueue, but maybe an old job is still in the queue under
 *     the canonical jobId" logic. Centralizing it here keeps that callable
 *     by both the sweeper and the recovery helper.
 *
 * What it does:
 *   - Periodically (every 30s) scans `transport_message_links` for stuck
 *     rows and (re-)enqueues them via the shared
 *     `enqueueOrRetryTransportDeliveryLink` helper.
 *   - Self-throttles: every retry bumps
 *     `metadata.delivery.sweeperRetryCount` and
 *     `metadata.delivery.lastSweeperRetryAt` (transport-neutral
 *     namespace; legacy `metadata.qq.*` slots are read as fallback
 *     for in-flight links carried over from before the namespace
 *     migration);
 *     ≥3 attempts in 10 minutes or ≥10 lifetime attempts or 24h since
 *     creation → dead-letter
 *     (`delivery_status='failed', metadata.lastError='exceeded_sweeper_retry_budget'`).
 *   - Uses a Redis-bound process lock (`im:outbox-sweeper:lock`) so
 *     multi-replica deployments only run one sweep at a time.
 *
 * Out of scope (handled elsewhere):
 *   - `binding_changed` skipped links — those need projection reset +
 *     new link, which lives in the delivery worker's binding-unavailable
 *     branch (G5 / Stage 8).
 *   - Inbound links — sweeper is outbound only.
 */

import type { Job, JobsOptions, Queue } from "bullmq"
import { sql } from "kysely"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { db } from "../infrastructure/database/kysely.js"
import { redis } from "../infrastructure/redis/index.js"
import { acquireLock, releaseLock } from "../infrastructure/redis/lock.js"
import { parseJsonObject } from "../modules/im/service/_helpers.js"
import { patchTransportMessageLinkMetadata } from "../modules/im/service.js"
import {
  canonicalTransportDeliveryJobId,
  IM_TRANSPORT_DELIVERY_JOB_DEFAULTS,
  imTransportDeliveryQueue,
} from "./queues.js"
import { createLogger } from "../infrastructure/logger/index.js"

const log = createLogger("outbox-sweeper")

const SWEEP_INTERVAL_MS = 30_000
const SWEEP_LOCK_KEY = "im:outbox-sweeper:lock"
const SWEEP_LOCK_TTL_MS = SWEEP_INTERVAL_MS - 5_000

const PENDING_STALE_INTERVAL = "5 minutes"
const FAILED_RECOVERABLE_INTERVAL = "1 hour"
const SKIPPED_RECOVERABLE_INTERVAL = "24 hours"

export const SWEEPER_BUDGET_PER_LINK = 10
export const SWEEPER_BUDGET_PER_10MIN = 3
export const SWEEPER_BUDGET_MAX_AGE_HOURS = 24

const RETRYABLE_LAST_ERROR_CODES: ReadonlySet<string> = new Set([
  // QQ retryable business codes (see openclaw-qqbot src/api.ts +
  // utils/chunked-upload.ts). Extend as new connectors land.
  "qq_token_refresh",
  "qq_network_timeout",
  "qq_5xx",
  "qq_304082", // 富媒体资源拉取失败 (please retry)
  "qq_304083",
  "qq_40068xxx", // platform-temporary
])

// ─────────────────────────────────────────────────────────────────
// Public helper used by both this sweeper and recovery callers
// ─────────────────────────────────────────────────────────────────

export type EnqueueOrRetryOutcome =
  | { kind: "skipped"; jobState: string }
  | { kind: "retried" }
  | { kind: "enqueued"; jobId: string }
  | { kind: "duplicate"; jobState: string }

/**
 * Make BullMQ pick up `linkId` for delivery. Handles the four states the
 * canonical jobId (`im-transport-delivery-{linkId}`) can be in:
 *   - waiting / delayed / active → already in-flight, skip
 *   - failed → call `job.retry()` so the same jobId continues
 *   - completed → previous run finished but the link is still stuck;
 *     bump a retry counter in link metadata and enqueue a new job with
 *     a suffixed jobId so BullMQ doesn't dedupe against the completed
 *     run
 *   - missing → enqueue under the canonical jobId
 *
 * Concurrent callers hitting the same linkId may race; BullMQ's
 * jobId dedupe will pick the first winner and the loser's `add()` call
 * returns the existing job. Both treat that as success.
 *
 * Returns an outcome enum for observability; callers may ignore.
 */
export async function enqueueOrRetryTransportDeliveryLink(
  linkId: string
): Promise<EnqueueOrRetryOutcome> {
  const trimmed = linkId.trim()
  if (!trimmed) return { kind: "skipped", jobState: "invalid-link-id" }

  const queue = imTransportDeliveryQueue
  const baseJobId = canonicalJobId(trimmed)
  const existing = await queue.getJob(baseJobId)
  if (existing) {
    const state = await existing.getState()
    if (
      state === "waiting" ||
      state === "delayed" ||
      state === "active" ||
      state === "waiting-children" ||
      state === "prioritized"
    ) {
      return { kind: "skipped", jobState: state }
    }
    if (state === "failed") {
      await existing.retry().catch(() => undefined)
      return { kind: "retried" }
    }
    if (state === "completed") {
      // Old job already done. Need a fresh job under a new jobId so BullMQ
      // doesn't dedupe against the completed one. Bump retry counter for
      // unique suffix.
      const nextCount = await bumpEnqueueRetryCount(trimmed)
      const suffixedJobId = `${baseJobId}-r${nextCount}`
      return enqueueOnce(queue, trimmed, suffixedJobId)
    }
    // Unknown state — try a fresh enqueue under a suffix to be safe.
    const nextCount = await bumpEnqueueRetryCount(trimmed)
    const suffixedJobId = `${baseJobId}-r${nextCount}`
    return enqueueOnce(queue, trimmed, suffixedJobId)
  }
  return enqueueOnce(queue, trimmed, baseJobId)
}

async function enqueueOnce(
  queue: Queue,
  linkId: string,
  jobId: string
): Promise<EnqueueOrRetryOutcome> {
  const opts: JobsOptions = {
    jobId,
    ...IM_TRANSPORT_DELIVERY_JOB_DEFAULTS,
  }
  try {
    await queue.add("deliver", { linkId }, opts)
    return { kind: "enqueued", jobId }
  } catch (err) {
    // BullMQ throws on jobId collision; surface that as duplicate so
    // concurrent callers see it as success.
    const job = await queue.getJob(jobId).catch(() => null)
    if (job) {
      const state = await job.getState().catch(() => "unknown")
      return { kind: "duplicate", jobState: state }
    }
    throw err
  }
}

/**
 * Re-export of the canonical BullMQ jobId producer that lives in
 * `queues.ts`. This module historically defined its own
 * `canonicalJobId` and the initial-enqueue path in `queues.ts` hand-
 * rolled the same string — if they ever drifted, BullMQ's jobId
 * dedup would break (sweeper wouldn't recognize the in-flight job
 * and would produce a duplicate enqueue). Now both call sites and
 * the sweeper's `queue.getJob(...)` lookup use the same function.
 *
 * Kept as a re-export rather than a fresh definition so existing
 * call sites (and the sweeper test) don't have to re-import from
 * `./queues.js` directly.
 */
export const canonicalJobId = canonicalTransportDeliveryJobId

/**
 * Read the current "enqueue retry count" off a link's metadata.
 *
 * Writes go to the neutral `metadata.delivery.deliveryEnqueueRetryCount`
 * slot (consistent with `sweeperRetryCount` / `lastSweeperRetryAt`),
 * but the reader falls back to the legacy `metadata.qq.*` slot so
 * in-flight links carried over from before the namespace migration
 * don't reset their budget. Exposed for the
 * `outbox-sweeper.test.ts` namespace-migration coverage.
 */
export function readEnqueueRetryCount(
  metadata: Record<string, unknown>
): number {
  const delivery = (
    metadata.delivery && typeof metadata.delivery === "object"
      ? (metadata.delivery as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>
  if (typeof delivery.deliveryEnqueueRetryCount === "number") {
    return delivery.deliveryEnqueueRetryCount
  }
  const legacyQq = (
    metadata.qq && typeof metadata.qq === "object"
      ? (metadata.qq as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>
  if (typeof legacyQq.deliveryEnqueueRetryCount === "number") {
    return legacyQq.deliveryEnqueueRetryCount
  }
  return 0
}

async function bumpEnqueueRetryCount(linkId: string): Promise<number> {
  // Single round-trip: read metadata, compute next, persist via the
  // existing deep-merge helper. The helper internally uses
  // SELECT FOR UPDATE + UPDATE so concurrent bumps serialize.
  //
  // Reads via `readEnqueueRetryCount` (neutral namespace with legacy
  // QQ fallback); writes go to the neutral `metadata.delivery.*`
  // slot so non-QQ connectors flowing through the same sweeper don't
  // grow `metadata.qq.*` ghost keys.
  const row = await db
    .selectFrom("transport_message_links")
    .select(["metadata"])
    .where("id", "=", linkId)
    .limit(1)
    .executeTakeFirst()
  const current = parseJsonObject(row?.metadata) as Record<string, unknown>
  const prev = readEnqueueRetryCount(current)
  const next = prev + 1
  await patchTransportMessageLinkMetadata({
    linkId,
    patch: {
      delivery: { deliveryEnqueueRetryCount: next },
    },
  })
  return next
}

// ─────────────────────────────────────────────────────────────────
// Sweeper loop
// ─────────────────────────────────────────────────────────────────

interface SweeperHandle {
  stop(): Promise<void>
}

let activeSweeper: SweeperHandle | null = null

export function startTransportOutboxSweeper(options?: {
  intervalMs?: number
}): void {
  if (activeSweeper) return
  const intervalMs = options?.intervalMs ?? SWEEP_INTERVAL_MS
  let stopped = false
  const sweepOnce = async () => {
    if (stopped) return
    try {
      await runOneSweep()
    } catch (err) {
      log.error({ err }, "sweep failed")
    }
  }
  // Kick off the first sweep ASAP after startup, then on the interval.
  void sweepOnce()
  const timer = setInterval(() => void sweepOnce(), intervalMs)
  timer.unref?.()
  activeSweeper = {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      activeSweeper = null
    },
  }
}

export async function stopTransportOutboxSweeper(): Promise<void> {
  if (activeSweeper) {
    await activeSweeper.stop()
  }
}

/**
 * Exposed for unit-style integration tests that want to trigger a sweep
 * synchronously. Production code should rely on `startTransportOutboxSweeper`.
 */
export async function runOneSweep(): Promise<void> {
  const lock = await acquireLock(redis, SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS)
  if (!lock) return
  try {
    const links = await loadSweepCandidates()
    for (const candidate of links) {
      try {
        await processCandidate(candidate)
      } catch (err) {
        log.error(
          { err, linkId: candidate.linkId },
          `failed to process link ${candidate.linkId}`
        )
      }
    }
  } finally {
    await releaseLock(redis, lock)
  }
}

interface SweepCandidate {
  linkId: string
  reason:
    | "pending_stale"
    | "failed_unknown_attempt"
    | "failed_retryable_error"
    | "skipped_recoverable"
  metadata: Record<string, unknown>
  createdAt: Date
}

async function loadSweepCandidates(): Promise<SweepCandidate[]> {
  // We load all three candidate classes in one query and let app code
  // bucket them. Using raw SQL because Kysely's jsonb operators aren't
  // exposed conveniently for `jsonb_path_exists`.
  const rows = await sql<{
    id: string
    delivery_status: "pending" | "sent" | "failed" | "skipped"
    metadata: unknown
    created_at: Date
    skipped_reason: string | null
    has_unknown_attempt: boolean
    last_error: string | null
  }>`
    SELECT
      id,
      delivery_status,
      metadata,
      created_at,
      metadata->>'skippedReason' AS skipped_reason,
      jsonb_path_exists(
        metadata,
        '$.qq.attempts.*.outcome ? (@ == "unknown" || @ == "unknown_assumed")'
      ) AS has_unknown_attempt,
      metadata->>'lastError' AS last_error
    FROM transport_message_links
    WHERE direction = 'outbound'
      AND (
        (delivery_status = 'pending'
          AND created_at < NOW() - INTERVAL '${sql.raw(PENDING_STALE_INTERVAL)}')
        OR (delivery_status = 'failed'
          AND updated_at > NOW() - INTERVAL '${sql.raw(FAILED_RECOVERABLE_INTERVAL)}')
        OR (delivery_status = 'skipped'
          AND metadata->>'skippedReason' IN ('binding_disabled','account_disabled')
          AND updated_at > NOW() - INTERVAL '${sql.raw(SKIPPED_RECOVERABLE_INTERVAL)}')
      )
    ORDER BY created_at ASC
    LIMIT 200
  `.execute(db)

  const out: SweepCandidate[] = []
  for (const row of rows.rows) {
    const metadata = parseJsonObject(row.metadata) as Record<string, unknown>
    if (row.delivery_status === "pending") {
      out.push({
        linkId: row.id,
        reason: "pending_stale",
        metadata,
        createdAt: row.created_at,
      })
    } else if (row.delivery_status === "failed") {
      const lastError = row.last_error?.split(":")[0]?.trim() ?? ""
      if (row.has_unknown_attempt) {
        out.push({
          linkId: row.id,
          reason: "failed_unknown_attempt",
          metadata,
          createdAt: row.created_at,
        })
      } else if (lastError && RETRYABLE_LAST_ERROR_CODES.has(lastError)) {
        out.push({
          linkId: row.id,
          reason: "failed_retryable_error",
          metadata,
          createdAt: row.created_at,
        })
      }
    } else if (
      row.delivery_status === "skipped" &&
      row.skipped_reason &&
      (row.skipped_reason === "binding_disabled" ||
        row.skipped_reason === "account_disabled")
    ) {
      // The recovery helper (G5) handles the canDeliverNow check + delivery_status
      // flip for these. The sweeper just hands them to the helper alongside
      // the retryable failed bucket.
      out.push({
        linkId: row.id,
        reason: "skipped_recoverable",
        metadata,
        createdAt: row.created_at,
      })
    }
  }
  return out
}

async function processCandidate(candidate: SweepCandidate): Promise<void> {
  const budgetCheck = checkSweeperBudget(candidate)
  if (budgetCheck === "dead_letter") {
    await markDeadLetter(candidate.linkId)
    return
  }
  if (budgetCheck === "skip") {
    return
  }

  // For skipped_recoverable we hand off to the recovery helper which
  // re-applies canDeliverNow and only flips skipped→pending if the
  // current binding still matches. Other reasons go through the helper
  // unchanged (`pending_stale` and `failed_*` are already in a state
  // the enqueue helper can act on).
  if (candidate.reason === "skipped_recoverable") {
    const { canDeliverNow, recoverSkippedDisabledLink } =
      await import("../modules/im/service/recovery.js")
    const result = await canDeliverNow(candidate.linkId)
    if (!result.ok) {
      // Either matched-but-still-disabled (silent skip; user must re-enable)
      // or endpoint mismatch (binding_changed path handled by delivery
      // worker on next attempt). Nothing to do here.
      return
    }
    await recoverSkippedDisabledLink(candidate.linkId)
  }

  await bumpSweeperRetryStamp(candidate.linkId)
  await enqueueOrRetryTransportDeliveryLink(candidate.linkId)
}

type BudgetCheck = "ok" | "skip" | "dead_letter"

/**
 * Read the current sweeper retry count off a link's metadata.
 *
 * Writes go to the neutral `metadata.delivery.sweeperRetryCount`
 * slot; the reader falls back to the legacy `metadata.qq.*` slot so
 * deploys without a backfill don't reset the budget for in-flight
 * links. Exposed for `outbox-sweeper.test.ts`.
 */
export function readSweeperRetryCount(
  metadata: Record<string, unknown>
): number {
  const delivery = (
    metadata.delivery && typeof metadata.delivery === "object"
      ? (metadata.delivery as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>
  if (typeof delivery.sweeperRetryCount === "number") {
    return delivery.sweeperRetryCount
  }
  const legacyQq = (
    metadata.qq && typeof metadata.qq === "object"
      ? (metadata.qq as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>
  if (typeof legacyQq.sweeperRetryCount === "number") {
    return legacyQq.sweeperRetryCount
  }
  return 0
}

/**
 * Read the last sweeper retry timestamp (ms-since-epoch) off a
 * link's metadata. Same neutral/legacy fallback as
 * `readSweeperRetryCount`. Returns 0 when no timestamp is set
 * (matches the original logic — "never retried" rather than "always
 * eligible").
 */
export function readLastSweeperRetryAtMs(
  metadata: Record<string, unknown>
): number {
  const delivery = (
    metadata.delivery && typeof metadata.delivery === "object"
      ? (metadata.delivery as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>
  if (typeof delivery.lastSweeperRetryAt === "string") {
    return Date.parse(delivery.lastSweeperRetryAt)
  }
  const legacyQq = (
    metadata.qq && typeof metadata.qq === "object"
      ? (metadata.qq as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>
  if (typeof legacyQq.lastSweeperRetryAt === "string") {
    return Date.parse(legacyQq.lastSweeperRetryAt)
  }
  return 0
}

/**
 * Pure budget predicate — pulled out of `checkSweeperBudget` so the
 * branching can be tested without constructing a full SweepCandidate
 * + faking Date.now. `now` defaults to `Date.now()`; tests pin it.
 *
 *   - returns `dead_letter` when lifetime count hit or link is older
 *     than the age cap;
 *   - returns `skip` when the per-10-minute burst budget is full;
 *   - otherwise `ok`.
 */
export function decideSweeperBudget(input: {
  retryCount: number
  lastRetryAtMs: number
  linkCreatedAtMs: number
  now: number
}): BudgetCheck {
  const ageHours = (input.now - input.linkCreatedAtMs) / 3_600_000
  if (
    input.retryCount >= SWEEPER_BUDGET_PER_LINK ||
    ageHours >= SWEEPER_BUDGET_MAX_AGE_HOURS
  ) {
    return "dead_letter"
  }
  const tenMinutesAgo = input.now - 10 * 60 * 1000
  if (
    input.lastRetryAtMs > tenMinutesAgo &&
    input.retryCount >= SWEEPER_BUDGET_PER_10MIN
  ) {
    return "skip"
  }
  return "ok"
}

function checkSweeperBudget(candidate: SweepCandidate): BudgetCheck {
  return decideSweeperBudget({
    retryCount: readSweeperRetryCount(candidate.metadata),
    lastRetryAtMs: readLastSweeperRetryAtMs(candidate.metadata),
    linkCreatedAtMs: candidate.createdAt.getTime(),
    now: Date.now(),
  })
}

async function bumpSweeperRetryStamp(linkId: string): Promise<void> {
  // Same pattern as bumpEnqueueRetryCount but for sweeper bookkeeping.
  const row = await db
    .selectFrom("transport_message_links")
    .select(["metadata"])
    .where("id", "=", linkId)
    .limit(1)
    .executeTakeFirst()
  const current = parseJsonObject(row?.metadata) as Record<string, unknown>
  // Read via the shared helper so the legacy `metadata.qq.*`
  // fallback applies uniformly. Writes always go to the neutral
  // `metadata.delivery.*` slot.
  const prev = readSweeperRetryCount(current)
  await patchTransportMessageLinkMetadata({
    linkId,
    patch: {
      delivery: {
        sweeperRetryCount: prev + 1,
        lastSweeperRetryAt: nowIsoInstant(),
      },
    },
  })
}

async function markDeadLetter(linkId: string): Promise<void> {
  await db
    .updateTable("transport_message_links")
    .set({
      delivery_status: "failed",
      metadata: sql`transport_message_links.metadata || ${JSON.stringify({
        lastError: "exceeded_sweeper_retry_budget",
      })}::jsonb`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", linkId)
    .execute()
}
