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
  const s = reduceStatus(
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
  const r = reduceStatus(s, { type: "tick", at: CFG.stallSoftMs }, CFG)
  assert.equal(r.next.phase, "in_flight")
  assert.equal(r.next.inFlightLevel, "stall")
  assert.deepEqual(r.effect, { kind: "set_reaction", level: "stall" })
})

test("REGRESSION: real path 10s soft stall → continued idle → 30s hard stall", () => {
  // Walk the actual lifecycle: caller sets thinking at t=0, the controller
  // applies it; nothing else happens; a tick at stallSoftMs promotes to
  // stall; then nothing else happens; a tick at stallHardMs MUST promote
  // to stall_hard. Previously broken because the !isStallStatus guard
  // skipped this branch once currentLevel became "stall".
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next // → in_flight
  s = reduceStatus(s, { type: "apply_finished", at: 900 }, CFG).next // → idle, thinking
  // Soft stall fires
  s = reduceStatus(s, { type: "tick", at: CFG.stallSoftMs }, CFG).next
  assert.equal(s.inFlightLevel, "stall")
  s = reduceStatus(
    s,
    { type: "apply_finished", at: CFG.stallSoftMs + 100 },
    CFG
  ).next
  assert.equal(s.currentLevel, "stall")
  assert.equal(s.phase, "idle")
  // Now the critical step: continued ticks while at stall must escalate
  // to stall_hard at CFG.stallHardMs (measured from lastActiveSince=0).
  const r = reduceStatus(s, { type: "tick", at: CFG.stallHardMs }, CFG)
  assert.equal(r.next.phase, "in_flight")
  assert.equal(r.next.inFlightLevel, "stall_hard")
  assert.deepEqual(r.effect, { kind: "set_reaction", level: "stall_hard" })
})

test("stall: lastActiveSince is bumped by request_set, resets stall timer", () => {
  // After stall fires, if the caller then drives the level back to thinking
  // (real activity), the stall ladder resets — a fresh stallSoftMs window
  // must pass before stall fires again.
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  s = reduceStatus(s, { type: "apply_finished", at: 900 }, CFG).next
  s = reduceStatus(s, { type: "tick", at: CFG.stallSoftMs }, CFG).next
  s = reduceStatus(
    s,
    { type: "apply_finished", at: CFG.stallSoftMs + 100 },
    CFG
  ).next
  // Caller indicates real activity again
  s = reduceStatus(
    s,
    { type: "request_set", level: "coding", at: CFG.stallSoftMs + 200 },
    CFG
  ).next
  assert.equal(s.lastActiveSince, CFG.stallSoftMs + 200)
  // A tick at the OLD stallHardMs boundary must NOT fire stall_hard now —
  // it should fire the pending "coding" set_reaction (or noop) instead.
  const r = reduceStatus(s, { type: "tick", at: CFG.stallHardMs - 100 }, CFG)
  if (r.effect.kind === "set_reaction") {
    assert.notEqual(
      r.effect.level,
      "stall_hard",
      "stall_hard must not fire after a real activity reset the timer"
    )
  }
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

test("apply_failed does NOT advance currentLevel (the platform never updated)", () => {
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  assert.equal(s.phase, "in_flight")
  assert.equal(s.inFlightLevel, "thinking")

  const r = reduceStatus(s, { type: "apply_failed", at: 900 }, CFG)
  // Exits in_flight so we don't loop
  assert.equal(r.next.phase, "idle")
  assert.equal(r.next.inFlightLevel, null)
  // Crucially: currentLevel did NOT advance. Optimistic apply was the
  // bug — it caused the next set("thinking") to no-op via the
  // identity check, leaving the platform stuck on the previous emoji.
  assert.equal(r.next.currentLevel, null)
  assert.equal(r.next.currentLevelSince, null)
})

test("apply_failed: same level retried by caller does NOT no-op (because currentLevel didn't advance)", () => {
  // Walk through the regression scenario directly: set thinking → fail
  // → caller retries set thinking. The retry must produce a fresh
  // pending window, not a no-op.
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  s = reduceStatus(s, { type: "apply_failed", at: 900 }, CFG).next
  const retry = reduceStatus(
    s,
    { type: "request_set", level: "thinking", at: 1000 },
    CFG
  )
  assert.equal(retry.next.phase, "pending")
  assert.equal(retry.next.desiredLevel, "thinking")
  assert.deepEqual(retry.effect, {
    kind: "schedule_tick",
    afterMs: CFG.debounceMs,
  })
})

test("apply_failed with newer queued desired drains the queue (might succeed)", () => {
  // Caller dispatched "thinking" → in_flight; then "tool" arrived while
  // in_flight (queued as desiredLevel); the "thinking" apply failed.
  // We should kick off the "tool" apply immediately.
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  s = reduceStatus(s, { type: "request_set", level: "tool", at: 850 }, CFG).next
  assert.equal(s.desiredLevel, "tool")

  const r = reduceStatus(s, { type: "apply_failed", at: 900 }, CFG)
  assert.equal(r.next.phase, "in_flight")
  assert.equal(r.next.inFlightLevel, "tool")
  assert.equal(r.next.desiredLevel, null)
  assert.deepEqual(r.effect, { kind: "set_reaction", level: "tool" })
  // Still no advance on currentLevel — the new dispatch is the next
  // chance to actually land a level.
  assert.equal(r.next.currentLevel, null)
})

test("apply_failed after a previous success: currentLevel stays at the last good level", () => {
  // First a successful "thinking" apply, then a failed "tool" apply.
  // currentLevel must remain "thinking" so future stall checks and
  // identity-skip behavior reflect what the platform actually shows.
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  s = reduceStatus(s, { type: "apply_finished", at: 900 }, CFG).next
  assert.equal(s.currentLevel, "thinking")

  s = reduceStatus(
    s,
    { type: "request_set", level: "tool", at: 1000 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 1800 }, CFG).next
  assert.equal(s.inFlightLevel, "tool")

  const r = reduceStatus(s, { type: "apply_failed", at: 1900 }, CFG)
  assert.equal(r.next.phase, "idle")
  assert.equal(r.next.currentLevel, "thinking", "platform still shows thinking")
  // Since we still have a (non-terminal) currentLevel showing, we keep
  // a stall watch going.
  assert.deepEqual(r.effect, {
    kind: "schedule_tick",
    afterMs: CFG.stallSoftMs,
  })
})

test("apply_failed: nothing was ever displayed → idle with no stall tick", () => {
  // currentLevel is null and the in-flight failed. There's nothing to
  // watch for stalling on, so the effect is noop. (A stall tick on an
  // empty slot would be meaningless and just churn the clock.)
  let s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "thinking", at: 0 },
    CFG
  ).next
  s = reduceStatus(s, { type: "tick", at: 800 }, CFG).next
  const r = reduceStatus(s, { type: "apply_failed", at: 900 }, CFG)
  assert.equal(r.next.phase, "idle")
  assert.equal(r.next.currentLevel, null)
  assert.deepEqual(r.effect, { kind: "noop" })
})

test("apply_failed on a terminal does NOT enter terminal_hold", () => {
  // request_set('done') → in_flight with terminalKind=done. The
  // platform call fails. We must NOT enter terminal_hold (there's no
  // emoji to hold) — drop to idle and clear terminalKind so a fresh
  // done()/error() from the caller can retry.
  const s = reduceStatus(
    INITIAL_STATUS_STATE,
    { type: "request_set", level: "done", at: 0 },
    CFG
  ).next
  assert.equal(s.phase, "in_flight")
  assert.equal(s.terminalKind, "done")

  const r = reduceStatus(s, { type: "apply_failed", at: 50 }, CFG)
  assert.notEqual(r.next.phase, "terminal_hold")
  assert.equal(r.next.phase, "idle")
  assert.equal(r.next.terminalKind, null)
  assert.equal(r.next.currentLevel, null)
  // Caller can now retry; not a no-op despite "done" usually being
  // terminal — handleRequestSet treats terminal_requested as the
  // "always re-dispatch" path.
  const retry = reduceStatus(
    r.next,
    { type: "request_set", level: "done", at: 100 },
    CFG
  )
  assert.equal(retry.next.phase, "in_flight")
  assert.deepEqual(retry.effect, { kind: "set_reaction", level: "done" })
})
