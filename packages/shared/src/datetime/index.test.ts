import { test } from "node:test"
import assert from "node:assert/strict"

import { formatChatTimestamp } from "./index.js"

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0) // fixed reference

test("relative style buckets by elapsed time (deterministic now)", () => {
  const rel = (ms: number) =>
    formatChatTimestamp(new Date(NOW - ms).toISOString(), "relative", {
      now: NOW,
    })
  assert.equal(rel(10_000), "now") // <1m
  assert.equal(rel(5 * 60_000), "5m")
  assert.equal(rel(3 * 3_600_000), "3h")
  assert.equal(rel(2 * 86_400_000), "2d")
  // >=7d falls back to a localized short date (just assert it's non-empty + not "Nd")
  const old = rel(30 * 86_400_000)
  assert.ok(old.length > 0)
  assert.ok(!/^\d+d$/.test(old))
})

test("empty / invalid input returns empty string for every style", () => {
  for (const style of ["relative", "inboxShort", "time"] as const) {
    assert.equal(formatChatTimestamp("", style), "")
    assert.equal(formatChatTimestamp(null, style), "")
    assert.equal(formatChatTimestamp(undefined, style), "")
    assert.equal(formatChatTimestamp("not-a-date", style), "")
  }
})

test("time and inboxShort styles produce non-empty localized strings", () => {
  const iso = new Date(NOW).toISOString()
  assert.ok(formatChatTimestamp(iso, "time").length > 0)
  assert.ok(formatChatTimestamp(iso, "inboxShort").length > 0)
})
