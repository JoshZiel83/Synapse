import test from "node:test"
import assert from "node:assert/strict"
import {
  assertIsoInstant,
  type IsoInstantString,
} from "@synapse/shared/datetime"
import {
  computeStatusFallbackCutoffIso,
  decideStatusLookupSource,
  type StatusFallbackInboundLink,
  type StatusInboundLinkLookup,
  type StatusRunningTurnRow,
} from "./actor-status-hooks.js"

/**
 * Pure-helper tests for the status fallback decision logic.
 *
 * Two helpers are covered:
 *
 *   - `computeStatusFallbackCutoffIso(runningTurn, now, windowMs)` — the
 *     single source-of-truth formula for the fallback cutoff. Used by
 *     both the SQL query (deriving cutoffIso) and the decide helper
 *     (deriving the in-helper comparison) so the two cannot drift.
 *
 *   - `decideStatusLookupSource({primaryLink, runningTurn, fallbackLink,
 *     now, starvationWindowMs?})` — the routing rule. Primary wins when
 *     present; otherwise fallback is allowed if its `createdAt` is
 *     within the cutoff; otherwise no link.
 *
 * Time inputs are ISO strings or `number`. All comparisons are
 * lexicographic between ISO-8601 `Z` strings (Postgres TIMESTAMPTZ
 * formatted via `.toISOString()`).
 */

const WINDOW_MS = 5 * 60 * 1000

function isoBefore(ms: number, offsetMs: number): IsoInstantString {
  return assertIsoInstant(new Date(ms - offsetMs).toISOString())
}

function primary(): StatusInboundLinkLookup {
  return {
    externalMessageId: "om_primary",
    endpointExternalId: "oc_chat",
    endpointType: "direct",
    transportKind: "feishu",
    transportAccountId: "acc-1",
  }
}

function fallback(createdAtIso: IsoInstantString): StatusFallbackInboundLink {
  return {
    externalMessageId: "om_fallback",
    endpointExternalId: "oc_chat",
    endpointType: "direct",
    transportKind: "feishu",
    transportAccountId: "acc-1",
    createdAt: createdAtIso,
  }
}

function turnWith(
  trigger_item_id: string | null,
  started_at: IsoInstantString | null
): StatusRunningTurnRow {
  return { trigger_item_id, started_at }
}

// ─── computeStatusFallbackCutoffIso ───

test("computeStatusFallbackCutoffIso: null runningTurn → now - windowMs", () => {
  const now = 1_700_000_000_000
  const cutoff = computeStatusFallbackCutoffIso(null, now)
  assert.equal(cutoff, new Date(now - WINDOW_MS).toISOString())
})

test("computeStatusFallbackCutoffIso: running with started_at → uses started_at", () => {
  const startedAt = assertIsoInstant("2026-05-24T12:00:00.000Z")
  const cutoff = computeStatusFallbackCutoffIso(
    turnWith("item-1", startedAt),
    1_700_000_000_000
  )
  assert.equal(cutoff, startedAt)
})

test("computeStatusFallbackCutoffIso: running with started_at=null → now - windowMs", () => {
  const now = 1_700_000_000_000
  const cutoff = computeStatusFallbackCutoffIso(turnWith("item-1", null), now)
  assert.equal(cutoff, new Date(now - WINDOW_MS).toISOString())
})

// ─── decideStatusLookupSource ───

test("primary present → {kind:'primary'} regardless of fallback / runningTurn", () => {
  const now = Date.now()
  const decision = decideStatusLookupSource({
    primaryLink: primary(),
    runningTurn: turnWith("item-1", isoBefore(now, 60_000)),
    fallbackLink: fallback(isoBefore(now, 1_000)),
    now,
  })
  assert.equal(decision.kind, "primary")
  assert.equal(decision.link?.externalMessageId, "om_primary")
})

test("primary null + running turn with trigger_item_id + fallback within started_at → fallback (trigger-item-without-link)", () => {
  const now = Date.now()
  const startedAt = isoBefore(now, 60_000)
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: turnWith("item-1", startedAt),
    fallbackLink: fallback(isoBefore(now, 30_000)),
    now,
  })
  assert.equal(decision.kind, "fallback")
  assert.equal(decision.reason, "trigger-item-without-link")
  assert.equal(decision.link?.externalMessageId, "om_fallback")
})

test("primary null + running turn without trigger_item_id + fallback within window → fallback (running-turn-without-trigger-item)", () => {
  const now = Date.now()
  const startedAt = isoBefore(now, 60_000)
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: turnWith(null, startedAt),
    fallbackLink: fallback(isoBefore(now, 30_000)),
    now,
  })
  assert.equal(decision.kind, "fallback")
  assert.equal(decision.reason, "running-turn-without-trigger-item")
})

test("primary null + running turn + fallback older than started_at → none", () => {
  const now = Date.now()
  const startedAt = isoBefore(now, 60_000)
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: turnWith("item-1", startedAt),
    fallbackLink: fallback(isoBefore(now, 90_000)), // older than startedAt
    now,
  })
  assert.equal(decision.kind, "none")
})

test("primary null + no running turn + fallback within 5min → fallback (no-running-turn)", () => {
  const now = Date.now()
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: null,
    fallbackLink: fallback(isoBefore(now, WINDOW_MS - 1_000)), // just inside
    now,
  })
  assert.equal(decision.kind, "fallback")
  assert.equal(decision.reason, "no-running-turn")
})

test("primary null + no running turn + fallback older than 5min → none", () => {
  const now = Date.now()
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: null,
    fallbackLink: fallback(isoBefore(now, WINDOW_MS + 1_000)), // just outside
    now,
  })
  assert.equal(decision.kind, "none")
})

test("primary null + no fallback link at all → none", () => {
  const now = Date.now()
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: turnWith(null, isoBefore(now, 60_000)),
    fallbackLink: null,
    now,
  })
  assert.equal(decision.kind, "none")
})

test("primary present + running turn with trigger_item_id but started_at=null → primary (independent of started_at)", () => {
  const now = Date.now()
  const decision = decideStatusLookupSource({
    primaryLink: primary(),
    runningTurn: turnWith("item-1", null),
    fallbackLink: null,
    now,
  })
  assert.equal(decision.kind, "primary")
  assert.equal(decision.link?.externalMessageId, "om_primary")
})

test("primary null + running turn started_at=null + fallback within 5min → fallback (running-turn-without-trigger-item or trigger-item-without-link)", () => {
  const now = Date.now()
  const decisionA = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: turnWith("item-1", null),
    fallbackLink: fallback(isoBefore(now, 60_000)),
    now,
  })
  assert.equal(decisionA.kind, "fallback")
  assert.equal(
    decisionA.reason,
    "trigger-item-without-link",
    "trigger_item_id present → reason classifies the missing-link case"
  )

  const decisionB = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: turnWith(null, null),
    fallbackLink: fallback(isoBefore(now, 60_000)),
    now,
  })
  assert.equal(decisionB.kind, "fallback")
  assert.equal(
    decisionB.reason,
    "running-turn-without-trigger-item",
    "trigger_item_id absent → reason classifies the no-trigger case"
  )
})

test("primary null + running turn started_at=null + fallback older than 5min → none (reverse case; null started_at does NOT collapse cutoff to unbounded)", () => {
  const now = Date.now()
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: turnWith("item-1", null),
    fallbackLink: fallback(isoBefore(now, WINDOW_MS + 60_000)),
    now,
  })
  assert.equal(decision.kind, "none")
})

test("edge case: cutoff and createdAt equal → fallback (>= boundary inclusive)", () => {
  const now = Date.now()
  const startedAt = isoBefore(now, 60_000)
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: turnWith(null, startedAt),
    fallbackLink: fallback(startedAt), // exactly equal to cutoff
    now,
  })
  assert.equal(decision.kind, "fallback")
})

test("custom starvationWindowMs is respected", () => {
  const now = Date.now()
  const customWindow = 10 * 60 * 1000
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: null,
    fallbackLink: fallback(isoBefore(now, 7 * 60 * 1000)), // 7 min ago
    now,
    starvationWindowMs: customWindow,
  })
  assert.equal(
    decision.kind,
    "fallback",
    "7 min ago is inside the 10-min custom window"
  )

  const decisionTight = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: null,
    fallbackLink: fallback(isoBefore(now, 7 * 60 * 1000)),
    now,
    starvationWindowMs: 5 * 60 * 1000, // back to default
  })
  assert.equal(
    decisionTight.kind,
    "none",
    "7 min ago is outside the 5-min default window"
  )
})

test("primary null + completed-only context (no running) + fallback older than 5min → none", () => {
  // No running turn = the case where ensureControllersForSession found
  // only completed turns (or no turns at all). Loader returns null in
  // both cases. Fallback must still respect the 5-min window.
  const now = Date.now()
  const decision = decideStatusLookupSource({
    primaryLink: null,
    runningTurn: null,
    fallbackLink: fallback(isoBefore(now, WINDOW_MS + 60_000)),
    now,
  })
  assert.equal(decision.kind, "none")
})
