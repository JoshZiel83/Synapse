import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_TYPING_CONFIG,
  INITIAL_TYPING_STATE,
  reduceTyping,
} from "./state.js"

const CFG = DEFAULT_TYPING_CONFIG

test("request_start transitions idle → starting and emits send start", () => {
  const r = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  )
  assert.equal(r.next.phase, "starting")
  assert.equal(r.next.startedAt, 0)
  assert.deepEqual(r.effect, { kind: "send", op: "start" })
})

test("send_ok in starting → active and schedules heartbeat", () => {
  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  const r = reduceTyping(s, { type: "send_ok", at: 100 }, CFG)
  assert.equal(r.next.phase, "active")
  assert.deepEqual(r.effect, { kind: "schedule_heartbeat", afterMs: 3000 })
})

test("heartbeat_tick while active sends another start", () => {
  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  s = reduceTyping(s, { type: "send_ok", at: 100 }, CFG).next
  const r = reduceTyping(s, { type: "heartbeat_tick", at: 3100 }, CFG)
  assert.deepEqual(r.effect, { kind: "send", op: "start" })
})

test("request_start is idempotent (no-op if already starting/active)", () => {
  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  let r = reduceTyping(s, { type: "request_start", at: 100 }, CFG)
  assert.deepEqual(r.effect, { kind: "noop" })

  s = reduceTyping(s, { type: "send_ok", at: 100 }, CFG).next
  r = reduceTyping(s, { type: "request_start", at: 200 }, CFG)
  assert.deepEqual(r.effect, { kind: "noop" })
})

test("request_stop while active triggers stop", () => {
  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  s = reduceTyping(s, { type: "send_ok", at: 100 }, CFG).next
  const r = reduceTyping(s, { type: "request_stop", at: 200 }, CFG)
  assert.equal(r.next.phase, "stopping")
  assert.deepEqual(r.effect, { kind: "send", op: "stop" })
})

test("send_ok in stopping → idle", () => {
  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  s = reduceTyping(s, { type: "send_ok", at: 100 }, CFG).next
  s = reduceTyping(s, { type: "request_stop", at: 200 }, CFG).next
  const r = reduceTyping(s, { type: "send_ok", at: 300 }, CFG)
  assert.equal(r.next.phase, "idle")
  assert.equal(r.next.startedAt, null)
})

test("stop is idempotent (no-op if idle/stopping)", () => {
  let r = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_stop", at: 0 },
    CFG
  )
  assert.deepEqual(r.effect, { kind: "noop" })

  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  s = reduceTyping(s, { type: "send_ok", at: 100 }, CFG).next
  s = reduceTyping(s, { type: "request_stop", at: 200 }, CFG).next
  r = reduceTyping(s, { type: "request_stop", at: 300 }, CFG)
  assert.deepEqual(r.effect, { kind: "noop" })
})

test("TTL forces stop on heartbeat_tick after ttlMs", () => {
  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  s = reduceTyping(s, { type: "send_ok", at: 100 }, CFG).next
  const r = reduceTyping(s, { type: "heartbeat_tick", at: CFG.ttlMs }, CFG)
  assert.equal(r.next.phase, "stopping")
  assert.deepEqual(r.effect, { kind: "send", op: "stop" })
})

test("ttl_check independently forces stop", () => {
  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  s = reduceTyping(s, { type: "send_ok", at: 100 }, CFG).next
  const r = reduceTyping(s, { type: "ttl_check", at: CFG.ttlMs + 100 }, CFG)
  assert.equal(r.next.phase, "stopping")
})

test("failure guard: after maxFailures consecutive failures, self-stop (no further sends)", () => {
  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  s = reduceTyping(s, { type: "send_failed", at: 100 }, CFG).next
  assert.equal(s.consecutiveFailures, 1)
  // Second failure tips us over
  const r = reduceTyping(s, { type: "send_failed", at: 200 }, CFG)
  assert.equal(r.next.phase, "idle")
  assert.deepEqual(r.effect, { kind: "noop" })
})

test("destroy while active sends final stop", () => {
  let s = reduceTyping(
    INITIAL_TYPING_STATE,
    { type: "request_start", at: 0 },
    CFG
  ).next
  s = reduceTyping(s, { type: "send_ok", at: 100 }, CFG).next
  const r = reduceTyping(s, { type: "destroy", at: 200 }, CFG)
  assert.equal(r.next.phase, "destroyed")
  assert.deepEqual(r.effect, { kind: "send", op: "stop" })
})

test("destroy while idle is silent (no stop sent)", () => {
  const r = reduceTyping(INITIAL_TYPING_STATE, { type: "destroy", at: 0 }, CFG)
  assert.equal(r.next.phase, "destroyed")
  assert.deepEqual(r.effect, { kind: "noop" })
})
