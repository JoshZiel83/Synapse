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
import { nowIsoInstant } from "@synapse/shared/datetime"
import { parseInstantString } from "../infrastructure/datetime.js"
import { redis } from "../infrastructure/redis/index.js"
import { acquireLock, releaseLock } from "../infrastructure/redis/lock.js"
import { patchTransportMessageLinkMetadata } from "../modules/im/service.js"
import {
  listTransportOutboxSweepCandidateRows,
  markTransportMessageLinkDeadLetter,
  selectTransportMessageLinkMetadata,
} from "../modules/im/service/repo.js"
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
  return readNamespacedMetadataNumber(metadata, "deliveryEnqueueRetryCount")
}

function readMetadataObject(
  metadata: Record<string, unknown>,
  key: "delivery" | "qq"
): Record<string, unknown> {
  const value = metadata[key]
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readNamespacedMetadataNumber(
  metadata: Record<string, unknown>,
  key: string
): number {
  const deliveryValue = readMetadataObject(metadata, "delivery")[key]
  if (typeof deliveryValue === "number") return deliveryValue
  const legacyValue = readMetadataObject(metadata, "qq")[key]
  return typeof legacyValue === "number" ? legacyValue : 0
}

function readNamespacedMetadataString(
  metadata: Record<string, unknown>,
  key: string
): string | undefined {
  const deliveryValue = readMetadataObject(metadata, "delivery")[key]
  if (typeof deliveryValue === "string") return deliveryValue
  const legacyValue = readMetadataObject(metadata, "qq")[key]
  return typeof legacyValue === "string" ? legacyValue : undefined
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
  const current = await selectTransportMessageLinkMetadata(linkId)
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

export interface SweepCandidate {
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
  const rows = await listTransportOutboxSweepCandidateRows()
  const out: SweepCandidate[] = []
  for (const row of rows) {
    if (row.deliveryStatus === "pending") {
      out.push({
        linkId: row.id,
        reason: "pending_stale",
        metadata: row.metadata,
        createdAt: row.createdAt,
      })
    } else if (row.deliveryStatus === "failed") {
      const lastError = row.lastError?.split(":")[0]?.trim() ?? ""
      if (row.hasUnknownAttempt) {
        out.push({
          linkId: row.id,
          reason: "failed_unknown_attempt",
          metadata: row.metadata,
          createdAt: row.createdAt,
        })
      } else if (lastError && RETRYABLE_LAST_ERROR_CODES.has(lastError)) {
        out.push({
          linkId: row.id,
          reason: "failed_retryable_error",
          metadata: row.metadata,
          createdAt: row.createdAt,
        })
      }
    } else if (
      row.deliveryStatus === "skipped" &&
      row.skippedReason &&
      (row.skippedReason === "binding_disabled" ||
        row.skippedReason === "account_disabled")
    ) {
      // The recovery helper (G5) handles the canDeliverNow check + delivery_status
      // flip for these. The sweeper just hands them to the helper alongside
      // the retryable failed bucket.
      out.push({
        linkId: row.id,
        reason: "skipped_recoverable",
        metadata: row.metadata,
        createdAt: row.createdAt,
      })
    }
  }
  return out
}

type ProcessSweepCandidateDeps = {
  checkBudget?: (candidate: SweepCandidate) => BudgetCheck
  markDeadLetter?: (linkId: string) => Promise<void>
  canDeliverNow?: (linkId: string) => Promise<{ ok: boolean }>
  recoverSkippedDisabledLink?: (linkId: string) => Promise<void>
  bumpRetryStamp?: (linkId: string) => Promise<void>
  enqueueOrRetry?: (linkId: string) => Promise<EnqueueOrRetryOutcome>
}

async function loadSkippedRecoveryDeps() {
  const { canDeliverNow, recoverSkippedDisabledLink } =
    await import("../modules/im/service/recovery.js")
  return { canDeliverNow, recoverSkippedDisabledLink }
}

export async function processSweepCandidate(
  candidate: SweepCandidate,
  deps: ProcessSweepCandidateDeps = {}
): Promise<void> {
  const bumpRetryStamp = deps.bumpRetryStamp ?? bumpSweeperRetryStamp
  const enqueueOrRetry =
    deps.enqueueOrRetry ?? enqueueOrRetryTransportDeliveryLink

  // Recoverable skipped links are waiting for an external state change
  // (account/binding re-enabled). They are not retry-looping while disabled, so
  // don't burn sweeper age/retry budget or dead-letter them before checking
  // whether delivery is possible again.
  if (candidate.reason === "skipped_recoverable") {
    const recoveryDeps =
      deps.canDeliverNow && deps.recoverSkippedDisabledLink
        ? null
        : await loadSkippedRecoveryDeps()
    const canDeliverNowFn = deps.canDeliverNow ?? recoveryDeps!.canDeliverNow
    const recoverSkippedDisabledLinkFn =
      deps.recoverSkippedDisabledLink ??
      recoveryDeps!.recoverSkippedDisabledLink
    const result = await canDeliverNowFn(candidate.linkId)
    if (!result.ok) {
      // Either matched-but-still-disabled (silent skip; user must re-enable)
      // or endpoint mismatch (binding_changed path handled by delivery
      // worker on next attempt). Nothing to do here.
      return
    }
    await recoverSkippedDisabledLinkFn(candidate.linkId)
    await bumpRetryStamp(candidate.linkId)
    await enqueueOrRetry(candidate.linkId)
    return
  }

  const budgetCheck = (deps.checkBudget ?? checkSweeperBudget)(candidate)
  if (budgetCheck === "dead_letter") {
    await (deps.markDeadLetter ?? markDeadLetter)(candidate.linkId)
    return
  }
  if (budgetCheck === "skip") {
    return
  }

  await bumpRetryStamp(candidate.linkId)
  await enqueueOrRetry(candidate.linkId)
}

async function processCandidate(candidate: SweepCandidate): Promise<void> {
  await processSweepCandidate(candidate)
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
  return readNamespacedMetadataNumber(metadata, "sweeperRetryCount")
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
  const lastSweeperRetryAt = readNamespacedMetadataString(
    metadata,
    "lastSweeperRetryAt"
  )
  if (lastSweeperRetryAt) {
    try {
      return parseInstantString(lastSweeperRetryAt).getTime()
    } catch {
      return 0
    }
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
  const current = await selectTransportMessageLinkMetadata(linkId)
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
  await markTransportMessageLinkDeadLetter(linkId)
}
