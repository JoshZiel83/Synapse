import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_STATUS_CONFIG,
  INITIAL_STATUS_STATE,
  reduceStatus,
  type StatusEffect,
  type StatusState,
} from "./state.js"

const CFG = DEFAULT_STATUS_CONFIG

function step(
  state: StatusState,
  events: Parameters<typeof reduceStatus>[1][]
): { state: StatusState; effects: StatusEffect[] } {
  let s = state
  const fx: StatusEffect[] = []
  for (const ev of events) {
    const r = reduceStatus(s, ev, CFG)
    s = r.next
    fx.push(r.effect)
  }
  return { state: s, effects: fx }
}

test("first set transitions idle → pending and schedules debounce tick", () => {
  const { state, effects } = step(INITIAL_STATUS_STATE, [
    { type: "request_set", level: "queued", at: 100 },
  ])
  assert.equal(state.phase, "pending")
  assert.equal(state.desiredLevel, "queued")
  assert.equal(state.pendingSince, 100)
  assert.deepEqual(effects[0], { kind: "schedule_tick", afterMs: 700 })
})

test("debounce coalesces multiple sets within the window — latest wins", () => {
  const { state, effects } = step(INITIAL_STATUS_STATE, [
    { type: "request_set", level: "queued", at: 100 },
    { type: "request_set", level: "thinking", at: 300 },
    { type: "request_set", level: "coding", at: 500 },
  ])
  assert.equal(state.desiredLevel, "coding")
  // Each set during pending re-schedules a tick
  assert.equal(effects.filter((e) => e.kind === "schedule_tick").length, 3)
})

test("debounce tick fires after debounceMs and emits set_reaction", () => {
  const { state } = step(INITIAL_STATUS_STATE, [
    { type: "request_set", level: "thinking", at: 100 },
  ])
  const r = reduceStatus(state, { type: "tick", at: 800 }, CFG)
  assert.equal(r.next.phase, "in_flight")
  assert.equal(r.next.inFlightLevel, "thinking")
  assert.deepEqual(r.effect, { kind: "set_reaction", level: "thinking" })
})

test("tick before debounce expires is a noop", () => {
  const { state } = step(INITIAL_STATUS_STATE, [
    { type: "request_set", level: "thinking", at: 100 },
  ])
  const r = reduceStatus(state, { type: "tick", at: 400 }, CFG)
  assert.equal(r.next.phase, "pending")
  assert.deepEqual(r.effect, { kind: "noop" })
})

test("apply_finished drains pending desired into next set_reaction", () => {
  // pending → in_flight at t=800 with thinking; another set queues coding
  let s = step(INITIAL_STATUS_STATE, [
    { type: "request_set", level: "thinking", at: 100 },
  ]).state
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  // Now in_flight thinking; queue coding
  s = reduceStatus(
    s,
    { type: "request_set", level: "coding", at: 850 },
    CFG
  ).next
  assert.equal(s.phase, "in_flight")
  assert.equal(s.desiredLevel, "coding")
  // Adapter finishes
  const r = reduceStatus(s, { type: "apply_finished", at: 900 }, CFG)
  assert.equal(r.next.phase, "in_flight")
  assert.equal(r.next.inFlightLevel, "coding")
  assert.deepEqual(r.effect, { kind: "set_reaction", level: "coding" })
})

test("apply_finished with no queue settles to idle and schedules stall tick", () => {
  let s = step(INITIAL_STATUS_STATE, [
    { type: "request_set", level: "thinking", at: 100 },
  ]).state
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  const r = reduceStatus(s, { type: "apply_finished", at: 900 }, CFG)
  assert.equal(r.next.phase, "idle")
  assert.equal(r.next.currentLevel, "thinking")
  assert.deepEqual(r.effect, {
    kind: "schedule_tick",
    afterMs: CFG.stallSoftMs,
  })
})

test("setting the same level twice while idle is a noop", () => {
  // Get into idle with currentLevel = thinking
  let s = step(INITIAL_STATUS_STATE, [
    { type: "request_set", level: "thinking", at: 100 },
  ]).state
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  s = reduceStatus(s, { type: "apply_finished", at: 900 }, CFG).next
  assert.equal(s.currentLevel, "thinking")
  // Re-request same level
  const r = reduceStatus(
    s,
    { type: "request_set", level: "thinking", at: 1000 },
    CFG
  )
  assert.deepEqual(r.effect, { kind: "noop" })
})

test("done() triggers immediate in_flight (no debounce)", () => {
  const r = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "done", at: 0 },
    CFG
  )
  assert.equal(r.next.phase, "in_flight")
  assert.equal(r.next.inFlightLevel, "done")
  assert.equal(r.next.terminalKind, "done")
  assert.deepEqual(r.effect, { kind: "set_reaction", level: "done" })
})

test("apply_finished after done enters terminal_hold + schedules clear", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "done", at: 0 },
    CFG
  ).next
  const r = reduceStatus(s, { type: "apply_finished", at: 50 }, CFG)
  assert.equal(r.next.phase, "terminal_hold")
  assert.equal(r.next.terminalSince, 50)
  assert.deepEqual(r.effect, { kind: "schedule_tick", afterMs: CFG.doneHoldMs })
})

test("tick after terminal hold expiry clears reaction and destroys", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "done", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "apply_finished", at: 50 }, CFG).next
  const r = reduceStatus(s, { type: "tick", at: 50 + CFG.doneHoldMs }, CFG)
  assert.equal(r.next.phase, "destroyed")
  assert.equal(r.next.currentLevel, null)
  assert.deepEqual(r.effect, { kind: "clear_reaction" })
})

test("error() uses errorHoldMs (longer than done)", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "error", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "apply_finished", at: 50 }, CFG).next
  // Tick at exactly doneHoldMs should NOT yet clear (errorHoldMs is longer)
  let r = reduceStatus(s, { type: "tick", at: 50 + CFG.doneHoldMs }, CFG)
  assert.equal(r.next.phase, "terminal_hold")
  // Tick at errorHoldMs does clear
  r = reduceStatus(s, { type: "tick", at: 50 + CFG.errorHoldMs }, CFG)
  assert.equal(r.next.phase, "destroyed")
})

test("terminal protection: set() after done is ignored", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "done", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "apply_finished", at: 50 }, CFG).next
  // Even non-terminal set is ignored once terminal_hold
  const r = reduceStatus(
    s,
    { type: "request_set", level: "thinking", at: 60 },
    CFG
  )
  assert.deepEqual(r.effect, { kind: "noop" })
  assert.equal(r.next.phase, "terminal_hold")
})

test("terminal-to-terminal transition allowed (done overrides done)", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "done", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "apply_finished", at: 50 }, CFG).next
  // Switching to error during hold IS allowed
  const r = reduceStatus(
    s,
    { type: "request_set", level: "error", at: 60 },
    CFG
  )
  assert.equal(r.next.phase, "in_flight")
  assert.equal(r.next.inFlightLevel, "error")
})

test("stall: idle non-terminal currentLevel held > stallSoftMs becomes stall", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next // → in_flight
  s = reduceStatus(s, { type: "apply_finished", at: 900 }, CFG).next // → idle
  const r = reduceStatus(s, { type: "tick", at: 900 + CFG.stallSoftMs }, CFG)
  assert.equal(r.next.phase, "in_flight")
  assert.equal(r.next.inFlightLevel, "stall")
  assert.deepEqual(r.effect, { kind: "set_reaction", level: "stall" })
})

test("stall_hard fires after stallHardMs without intermediate progress", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  s = reduceStatus(s, { type: "apply_finished", at: 900 }, CFG).next
  const r = reduceStatus(s, { type: "tick", at: 900 + CFG.stallHardMs }, CFG)
  assert.equal(r.next.inFlightLevel, "stall_hard")
})

test("destroy clears any currentLevel and freezes the controller", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  s = reduceStatus(s, { type: "apply_finished", at: 900 }, CFG).next
  const r = reduceStatus(s, { type: "destroy", at: 1000 }, CFG)
  assert.equal(r.next.phase, "destroyed")
  assert.deepEqual(r.effect, { kind: "clear_reaction" })
  // After destroy, all events are no-ops
  const after = reduceStatus(
    r.next,
    { type: "request_set", level: "thinking", at: 2000 },
    CFG
  )
  assert.deepEqual(after.effect, { kind: "noop" })
})

test("destroy when no reaction was set is noop (no clear)", () => {
  const r = reduceStatus(INITIAL_STATUS_STATE, { type: "destroy", at: 0 }, CFG)
  assert.equal(r.next.phase, "destroyed")
  assert.deepEqual(r.effect, { kind: "noop" })
})

test("apply_failed still moves out of in_flight (no infinite loop)", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  assert.equal(s.phase, "in_flight")
  const r = reduceStatus(s, { type: "apply_failed", at: 900 }, CFG)
  // We DO update currentLevel optimistically on apply_failed, matching apply_finished
  // behavior (the next set will retry). Test that we exit in_flight.
  assert.equal(r.next.phase, "idle")
  assert.equal(r.next.inFlightLevel, null)
})
