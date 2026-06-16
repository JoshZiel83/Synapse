/**
 * Pure-function tests for the outbox sweeper's metadata-namespace +
 * budget logic. Coverage is intentionally scoped to the parts that
 * don't require a live BullMQ queue or Postgres connection:
 *
 *   - `readEnqueueRetryCount` / `readSweeperRetryCount` /
 *     `readLastSweeperRetryAtMs` — assert that writes go to the
 *     neutral `metadata.delivery.*` namespace while legacy
 *     `metadata.qq.*` slots are still readable (migration safety
 *     for links carried across the deploy).
 *
 *   - `decideSweeperBudget` — the dead-letter / skip / ok decision
 *     tree, pinned to specific (count, lastRetry, age, now) shapes
 *     so a future tweak to the burst window or lifetime cap doesn't
 *     silently move the threshold.
 *
 *   - `canonicalJobId` — the BullMQ-job-id dedup key. Sweeper +
 *     projection worker both rely on this string being stable per
 *     link.
 *
 * The orchestration paths (`processCandidate`, `runOneSweep`) still
 * need an integration test with a real Redis-backed BullMQ queue and
 * a real Postgres; that's tracked separately. Pinning the pure parts
 * here is the smallest move that catches the kind of regression the
 * reviewer flagged (namespace drift on the rename).
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  canonicalJobId,
  decideSweeperBudget,
  processSweepCandidate,
  readEnqueueRetryCount,
  readLastSweeperRetryAtMs,
  readSweeperRetryCount,
  SWEEPER_BUDGET_PER_10MIN,
  SWEEPER_BUDGET_PER_LINK,
  SWEEPER_BUDGET_MAX_AGE_HOURS,
  type SweepCandidate,
} from "./outbox-sweeper.js"
// `canonicalTransportDeliveryJobId` is the producer the initial
// enqueue path (`enqueueTransportDeliveryJobs` in queues.ts) uses
// for the BullMQ jobId. The sweeper's `canonicalJobId` MUST be the
// same function — see review #8 for the regression class this
// guards against.
import { canonicalTransportDeliveryJobId } from "./queues.js"

// ─── namespace migration: enqueue retry count ───

test("readEnqueueRetryCount: returns 0 on empty metadata", () => {
  assert.equal(readEnqueueRetryCount({}), 0)
})

test("readEnqueueRetryCount: reads from neutral metadata.delivery namespace", () => {
  assert.equal(
    readEnqueueRetryCount({ delivery: { deliveryEnqueueRetryCount: 4 } }),
    4
  )
})

test("readEnqueueRetryCount: falls back to legacy metadata.qq for pre-migration links", () => {
  assert.equal(
    readEnqueueRetryCount({ qq: { deliveryEnqueueRetryCount: 7 } }),
    7
  )
})

test("readEnqueueRetryCount: neutral namespace wins over legacy when both present", () => {
  // Realistic post-migration state: a new write landed in
  // `metadata.delivery.*` for an already-bumped link that still
  // carried a legacy `metadata.qq.*` value. The new write must win
  // or the budget would silently regress.
  assert.equal(
    readEnqueueRetryCount({
      delivery: { deliveryEnqueueRetryCount: 5 },
      qq: { deliveryEnqueueRetryCount: 2 },
    }),
    5
  )
})

test("metadata namespace readers ignore arrays and continue to fallback", () => {
  const legacyIso = "2026-05-28T11:00:00.000Z"
  assert.equal(
    readEnqueueRetryCount({
      delivery: [{ deliveryEnqueueRetryCount: 8 }],
      qq: { deliveryEnqueueRetryCount: 3 },
    }),
    3
  )
  assert.equal(
    readSweeperRetryCount({
      delivery: [{ sweeperRetryCount: 8 }],
      qq: { sweeperRetryCount: 4 },
    }),
    4
  )
  assert.equal(
    readLastSweeperRetryAtMs({
      delivery: [{ lastSweeperRetryAt: "2026-05-28T10:00:00.000Z" }],
      qq: { lastSweeperRetryAt: legacyIso },
    }),
    Date.parse(legacyIso)
  )
})

test("readEnqueueRetryCount: ignores non-number values in either namespace", () => {
  // Defensive: a corrupted JSON column shouldn't produce NaN or
  // bypass the budget.
  assert.equal(
    readEnqueueRetryCount({
      delivery: { deliveryEnqueueRetryCount: "not-a-number" },
    }),
    0
  )
  assert.equal(
    readEnqueueRetryCount({
      qq: { deliveryEnqueueRetryCount: null },
    }),
    0
  )
})

// ─── namespace migration: sweeper retry count ───

test("readSweeperRetryCount: neutral metadata.delivery namespace", () => {
  assert.equal(readSweeperRetryCount({ delivery: { sweeperRetryCount: 3 } }), 3)
})

test("readSweeperRetryCount: falls back to legacy metadata.qq", () => {
  assert.equal(readSweeperRetryCount({ qq: { sweeperRetryCount: 9 } }), 9)
})

test("readSweeperRetryCount: neutral wins over legacy when both present", () => {
  assert.equal(
    readSweeperRetryCount({
      delivery: { sweeperRetryCount: 1 },
      qq: { sweeperRetryCount: 100 },
    }),
    1
  )
})

// ─── namespace migration: sweeper retry timestamp ───

test("readLastSweeperRetryAtMs: ISO string in neutral namespace → epoch ms", () => {
  // The sweeper writes `new Date().toISOString()`; this verifies the
  // reader handles that exact shape rather than only specific
  // timezone offsets.
  const iso = "2026-05-28T10:00:00.000Z"
  assert.equal(
    readLastSweeperRetryAtMs({ delivery: { lastSweeperRetryAt: iso } }),
    Date.parse(iso)
  )
})

test("readLastSweeperRetryAtMs: falls back to legacy metadata.qq", () => {
  const iso = "2026-05-28T11:00:00.000Z"
  assert.equal(
    readLastSweeperRetryAtMs({ qq: { lastSweeperRetryAt: iso } }),
    Date.parse(iso)
  )
})

test("readLastSweeperRetryAtMs: returns 0 when no timestamp present", () => {
  assert.equal(readLastSweeperRetryAtMs({}), 0)
})

// ─── budget predicate ───
//
// `decideSweeperBudget` is the pure core of `checkSweeperBudget`. The
// branching is:
//   - `dead_letter`: lifetime retry count hit, OR link age >= 24h
//   - `skip`:        burst budget (3 retries / 10min window) full
//   - `ok`:          otherwise
//
// Pinning specific (count, lastRetry, age) shapes guards against
// silent regression if someone tweaks the thresholds — the tests
// would have to be updated explicitly.

const NOW = 1_700_000_000_000 // arbitrary fixed epoch ms
const ONE_HOUR_MS = 3_600_000

test("decideSweeperBudget: under all caps → ok", () => {
  assert.equal(
    decideSweeperBudget({
      retryCount: 0,
      lastRetryAtMs: 0,
      linkCreatedAtMs: NOW - ONE_HOUR_MS, // 1h old
      now: NOW,
    }),
    "ok"
  )
})

test("decideSweeperBudget: lifetime count at the cap → dead_letter", () => {
  assert.equal(
    decideSweeperBudget({
      retryCount: SWEEPER_BUDGET_PER_LINK,
      lastRetryAtMs: 0,
      linkCreatedAtMs: NOW - ONE_HOUR_MS,
      now: NOW,
    }),
    "dead_letter"
  )
})

test("decideSweeperBudget: link older than max age → dead_letter even with 0 retries", () => {
  assert.equal(
    decideSweeperBudget({
      retryCount: 0,
      lastRetryAtMs: 0,
      linkCreatedAtMs: NOW - SWEEPER_BUDGET_MAX_AGE_HOURS * ONE_HOUR_MS,
      now: NOW,
    }),
    "dead_letter"
  )
})

test("decideSweeperBudget: burst window full → skip", () => {
  // Three retries (the per-10-min cap) within the window → skip
  // rather than enqueue another immediately.
  assert.equal(
    decideSweeperBudget({
      retryCount: SWEEPER_BUDGET_PER_10MIN,
      lastRetryAtMs: NOW - 30_000, // 30s ago, well inside the 10min window
      linkCreatedAtMs: NOW - ONE_HOUR_MS,
      now: NOW,
    }),
    "skip"
  )
})

test("decideSweeperBudget: burst-window stale (>10min) lets the next retry through", () => {
  // Same retryCount as the skip case above, but the last attempt
  // is older than the 10-minute window so the burst counter is
  // effectively reset.
  assert.equal(
    decideSweeperBudget({
      retryCount: SWEEPER_BUDGET_PER_10MIN,
      lastRetryAtMs: NOW - 11 * 60 * 1000, // 11min ago
      linkCreatedAtMs: NOW - ONE_HOUR_MS,
      now: NOW,
    }),
    "ok"
  )
})

test("decideSweeperBudget: dead_letter wins over skip when both fire", () => {
  // If the link is both over the burst budget AND past lifetime/age,
  // it must dead-letter rather than just skip — otherwise it'd loop
  // forever as the burst skip clears.
  assert.equal(
    decideSweeperBudget({
      retryCount: SWEEPER_BUDGET_PER_LINK,
      lastRetryAtMs: NOW - 30_000,
      linkCreatedAtMs: NOW - ONE_HOUR_MS,
      now: NOW,
    }),
    "dead_letter"
  )
})

// ─── BullMQ job id dedup contract ───

test("canonicalJobId: deterministic per link id", () => {
  assert.equal(canonicalJobId("abc"), canonicalJobId("abc"))
})

test("canonicalJobId: differs per link id", () => {
  assert.notEqual(canonicalJobId("abc"), canonicalJobId("def"))
})

test("canonicalJobId === canonicalTransportDeliveryJobId — same producer for enqueue + sweeper lookup", () => {
  // Critical regression guard for review #8: if `queues.ts`'s
  // initial-enqueue path and the sweeper's `getJob(...)` lookup ever
  // produced different strings for the same linkId, BullMQ's jobId
  // dedup would silently break — the sweeper would think no job
  // existed for the link and produce a duplicate enqueue. Asserting
  // both are the same function (and produce byte-identical output)
  // is the strongest contract we can pin in a unit test.
  assert.equal(canonicalJobId, canonicalTransportDeliveryJobId)
  for (const linkId of ["abc", "00000000-0000-0000-0000-000000000001", "x"]) {
    assert.equal(
      canonicalJobId(linkId),
      canonicalTransportDeliveryJobId(linkId),
      `jobId producers diverged for linkId=${linkId}`
    )
  }
})

test("canonicalJobId: format matches the persisted Redis key shape", () => {
  // Hard-pin the format because the BullMQ keyspace is persisted to
  // Redis — changing it without a coordinated rollout would orphan
  // every in-flight job in production. If you intentionally change
  // the format, you also have to plan a migration; this test fails
  // loudly so the decision is explicit.
  assert.equal(canonicalJobId("link-123"), "im-transport-delivery-link-123")
})

function sweepCandidate(
  overrides: Partial<SweepCandidate> = {}
): SweepCandidate {
  return {
    linkId: "link-1",
    reason: "pending_stale",
    metadata: {},
    createdAt: new Date(NOW - ONE_HOUR_MS),
    ...overrides,
  }
}

test("processSweepCandidate: skipped recovery waits without budget dead-letter when not deliverable", async () => {
  const calls: string[] = []
  await processSweepCandidate(
    sweepCandidate({
      reason: "skipped_recoverable",
      createdAt: new Date(
        NOW - (SWEEPER_BUDGET_MAX_AGE_HOURS + 1) * ONE_HOUR_MS
      ),
      metadata: { delivery: { sweeperRetryCount: SWEEPER_BUDGET_PER_LINK } },
    }),
    {
      checkBudget() {
        calls.push("checkBudget")
        return "dead_letter"
      },
      markDeadLetter: async () => {
        calls.push("markDeadLetter")
      },
      canDeliverNow: async () => {
        calls.push("canDeliverNow")
        return { ok: false }
      },
      recoverSkippedDisabledLink: async () => {
        calls.push("recover")
      },
      bumpRetryStamp: async () => {
        calls.push("bump")
      },
      enqueueOrRetry: async () => {
        calls.push("enqueue")
        return { kind: "enqueued", jobId: "job-1" }
      },
    }
  )

  assert.deepEqual(calls, ["canDeliverNow"])
})

test("processSweepCandidate: skipped recovery flips then enqueues once deliverable", async () => {
  const calls: string[] = []
  await processSweepCandidate(
    sweepCandidate({
      reason: "skipped_recoverable",
      createdAt: new Date(
        NOW - (SWEEPER_BUDGET_MAX_AGE_HOURS + 1) * ONE_HOUR_MS
      ),
    }),
    {
      checkBudget() {
        calls.push("checkBudget")
        return "dead_letter"
      },
      canDeliverNow: async () => {
        calls.push("canDeliverNow")
        return { ok: true }
      },
      recoverSkippedDisabledLink: async () => {
        calls.push("recover")
      },
      bumpRetryStamp: async () => {
        calls.push("bump")
      },
      enqueueOrRetry: async () => {
        calls.push("enqueue")
        return { kind: "enqueued", jobId: "job-1" }
      },
    }
  )

  assert.deepEqual(calls, ["canDeliverNow", "recover", "bump", "enqueue"])
})

test("processSweepCandidate: skipped recovery stops before enqueue when recover fails", async () => {
  const calls: string[] = []
  await assert.rejects(
    () =>
      processSweepCandidate(
        sweepCandidate({
          reason: "skipped_recoverable",
        }),
        {
          canDeliverNow: async () => {
            calls.push("canDeliverNow")
            return { ok: true }
          },
          recoverSkippedDisabledLink: async () => {
            calls.push("recover")
            throw new Error("recover failed")
          },
          bumpRetryStamp: async () => {
            calls.push("bump")
          },
          enqueueOrRetry: async () => {
            calls.push("enqueue")
            return { kind: "enqueued", jobId: "job-1" }
          },
        }
      ),
    /recover failed/
  )

  assert.deepEqual(calls, ["canDeliverNow", "recover"])
})

test("processSweepCandidate: skipped recovery stops before enqueue when retry stamp fails", async () => {
  const calls: string[] = []
  await assert.rejects(
    () =>
      processSweepCandidate(
        sweepCandidate({
          reason: "skipped_recoverable",
        }),
        {
          canDeliverNow: async () => {
            calls.push("canDeliverNow")
            return { ok: true }
          },
          recoverSkippedDisabledLink: async () => {
            calls.push("recover")
          },
          bumpRetryStamp: async () => {
            calls.push("bump")
            throw new Error("stamp failed")
          },
          enqueueOrRetry: async () => {
            calls.push("enqueue")
            return { kind: "enqueued", jobId: "job-1" }
          },
        }
      ),
    /stamp failed/
  )

  assert.deepEqual(calls, ["canDeliverNow", "recover", "bump"])
})

test("processSweepCandidate: retrying candidates still honor dead-letter budget", async () => {
  const calls: string[] = []
  await processSweepCandidate(
    sweepCandidate({ reason: "failed_retryable_error" }),
    {
      checkBudget() {
        calls.push("checkBudget")
        return "dead_letter"
      },
      markDeadLetter: async () => {
        calls.push("markDeadLetter")
      },
      bumpRetryStamp: async () => {
        calls.push("bump")
      },
      enqueueOrRetry: async () => {
        calls.push("enqueue")
        return { kind: "enqueued", jobId: "job-1" }
      },
    }
  )

  assert.deepEqual(calls, ["checkBudget", "markDeadLetter"])
})

test("processSweepCandidate: retrying candidates skip without side effects when burst budget is full", async () => {
  const calls: string[] = []
  await processSweepCandidate(sweepCandidate({ reason: "pending_stale" }), {
    checkBudget() {
      calls.push("checkBudget")
      return "skip"
    },
    markDeadLetter: async () => {
      calls.push("markDeadLetter")
    },
    bumpRetryStamp: async () => {
      calls.push("bump")
    },
    enqueueOrRetry: async () => {
      calls.push("enqueue")
      return { kind: "enqueued", jobId: "job-1" }
    },
  })

  assert.deepEqual(calls, ["checkBudget"])
})

test("processSweepCandidate: retrying candidates stop before enqueue when retry stamp fails", async () => {
  const calls: string[] = []
  await assert.rejects(
    () =>
      processSweepCandidate(sweepCandidate({ reason: "pending_stale" }), {
        checkBudget() {
          calls.push("checkBudget")
          return "ok"
        },
        bumpRetryStamp: async () => {
          calls.push("bump")
          throw new Error("stamp failed")
        },
        enqueueOrRetry: async () => {
          calls.push("enqueue")
          return { kind: "enqueued", jobId: "job-1" }
        },
      }),
    /stamp failed/
  )

  assert.deepEqual(calls, ["checkBudget", "bump"])
})

test("processSweepCandidate: skipped recovery surfaces enqueue failures after retry stamp", async () => {
  const calls: string[] = []
  await assert.rejects(
    () =>
      processSweepCandidate(
        sweepCandidate({
          reason: "skipped_recoverable",
        }),
        {
          canDeliverNow: async () => {
            calls.push("canDeliverNow")
            return { ok: true }
          },
          recoverSkippedDisabledLink: async () => {
            calls.push("recover")
          },
          bumpRetryStamp: async () => {
            calls.push("bump")
          },
          enqueueOrRetry: async () => {
            calls.push("enqueue")
            throw new Error("enqueue failed")
          },
        }
      ),
    /enqueue failed/
  )

  assert.deepEqual(calls, ["canDeliverNow", "recover", "bump", "enqueue"])
})

test("processSweepCandidate: retrying candidates surface enqueue failures without dead-lettering", async () => {
  const calls: string[] = []
  await assert.rejects(
    () =>
      processSweepCandidate(sweepCandidate({ reason: "pending_stale" }), {
        checkBudget() {
          calls.push("checkBudget")
          return "ok"
        },
        markDeadLetter: async () => {
          calls.push("markDeadLetter")
        },
        bumpRetryStamp: async () => {
          calls.push("bump")
        },
        enqueueOrRetry: async () => {
          calls.push("enqueue")
          throw new Error("enqueue failed")
        },
      }),
    /enqueue failed/
  )

  assert.deepEqual(calls, ["checkBudget", "bump", "enqueue"])
})
