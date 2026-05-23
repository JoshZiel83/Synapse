import test from "node:test"
import assert from "node:assert/strict"
import {
  decideRuntimeUpdateAction,
  resolveActorActionStatus,
  resolveRuntimePhaseStatus,
  resolveSessionThinkingStatus,
} from "./status-resolver.js"

test("actor.action with web tool resolves to web", () => {
  assert.equal(
    resolveActorActionStatus({
      actions: [{ tool: "web_search", args: {} }],
    }),
    "web"
  )
})

test("actor.action with coding tool resolves to coding", () => {
  assert.equal(
    resolveActorActionStatus({
      actions: [{ name: "edit_file" }],
    }),
    "coding"
  )
})

test("actor.action with multiple tools picks the dominant (coding > web)", () => {
  assert.equal(
    resolveActorActionStatus({
      actions: [{ name: "web_search" }, { name: "edit_file" }],
    }),
    "coding"
  )
})

test("actor.action with empty actions returns null (caller decides done)", () => {
  assert.equal(resolveActorActionStatus({ actions: [] }), null)
  assert.equal(resolveActorActionStatus({}), null)
})

test("actor.action with unknown tool falls back to tool", () => {
  assert.equal(
    resolveActorActionStatus({ actions: [{ name: "mystery_op" }] }),
    "tool"
  )
})

test("session.thinking with phase=tool uses tool", () => {
  assert.equal(resolveSessionThinkingStatus({ phase: "tool" }), "tool")
})

test("session.thinking with phase=done returns done", () => {
  assert.equal(resolveSessionThinkingStatus({ phase: "done" }), "done")
})

test("session.thinking default is thinking", () => {
  assert.equal(resolveSessionThinkingStatus({}), "thinking")
  assert.equal(
    resolveSessionThinkingStatus({ status: "Analyzing message..." }),
    "thinking"
  )
})

// resolveRuntimePhaseStatus — maps ActorRuntimePhase → StatusLevel for the
// runtime.updated handler. Only "thinking" / "tool" / "responding" produce
// a reaction level; the other phases are either terminal (handled separately)
// or wait-states that should leave the previous reaction in place.

test("runtime phase=thinking → thinking level", () => {
  assert.equal(resolveRuntimePhaseStatus("thinking"), "thinking")
})

test("runtime phase=tool → tool level", () => {
  assert.equal(resolveRuntimePhaseStatus("tool"), "tool")
})

test("runtime phase=responding → coding level (model writing output)", () => {
  assert.equal(resolveRuntimePhaseStatus("responding"), "coding")
})

test("runtime phase=idle / blocked / error / unknown → null (no mid-flight change)", () => {
  assert.equal(resolveRuntimePhaseStatus("idle"), null)
  assert.equal(resolveRuntimePhaseStatus("blocked"), null)
  assert.equal(resolveRuntimePhaseStatus("error"), null)
  assert.equal(resolveRuntimePhaseStatus("wat"), null)
  assert.equal(resolveRuntimePhaseStatus(""), null)
})

// decideRuntimeUpdateAction — the full snapshot → action mapping the
// runtime.updated handler uses. Regression coverage for the IM hook
// rewire that replaced the deleted session.thinking + session.status.changed
// subscriptions (which left typing stuck "on" and reactions stuck mid-turn).

test("decision: hard error (health=error) → terminal-error", () => {
  // session-thinking publishes this on the catch-all error path.
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "blocked",
      health: "error",
      phase: "error",
    }),
    { kind: "terminal-error" }
  )
})

test("decision: phase=error alone is NOT terminal (may be inherited stale phase from cache)", () => {
  // The runtime snapshot builder inherits cached phase when overrides
  // don't supply one. A previously-blocked session re-enqueued via
  // enqueueSessionWakeup() emits {laneState:"queued", health:"ok"} with
  // no phase override, so phase="error" leaks through from the previous
  // failure. Without corroborating health/laneState, the IM hook must
  // treat this as a non-actionable churn event, not a terminal cleanup —
  // otherwise it tears down the controllers right as the next turn starts.
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "queued",
      health: "ok",
      phase: "error",
    }),
    { kind: "noop" }
  )
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "running",
      health: "ok",
      phase: "error",
    }),
    { kind: "noop" }
  )
})

test("decision: phase=error WITH corroborating laneState=blocked → terminal-error", () => {
  // This is the canonical hard-failure shape session-thinking publishes
  // on the catch-all error path. health="error" is also set in practice
  // but laneState alone is enough corroboration.
  assert.deepEqual(
    decideRuntimeUpdateAction({ laneState: "blocked", phase: "error" }),
    { kind: "terminal-error" }
  )
})

test("decision: laneState=closed → terminal-error", () => {
  assert.deepEqual(
    decideRuntimeUpdateAction({ laneState: "closed", phase: "idle" }),
    { kind: "terminal-error" }
  )
})

test("decision: clean completion (idle+idle) → terminal-done", () => {
  // session-thinking publishes this at end-of-turn after putSessionToIdle.
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "idle",
      health: "ok",
      phase: "idle",
    }),
    { kind: "terminal-done" }
  )
})

test("decision: queued-follow-up (queued+idle) is NOT terminal", () => {
  // After a turn completes with more pending wakeups, session-thinking
  // publishes {laneState:"queued", phase:"idle"} to indicate "follow-up
  // pending" — the reaction MUST stay alive and typing should not stop the
  // way it does on real completion.
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "queued",
      health: "ok",
      phase: "idle",
    }),
    { kind: "noop" }
  )
})

test("decision: running+thinking → set-level=thinking + (handler stops typing)", () => {
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "running",
      health: "ok",
      phase: "thinking",
    }),
    { kind: "set-level", level: "thinking" }
  )
})

test("decision: running+tool → set-level=tool", () => {
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "running",
      health: "ok",
      phase: "tool",
    }),
    { kind: "set-level", level: "tool" }
  )
})

test("decision: running+responding → set-level=coding (model writing output)", () => {
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "running",
      health: "ok",
      phase: "responding",
    }),
    { kind: "set-level", level: "coding" }
  )
})

test("decision: running+blocked (wait state) → noop (keep previous reaction)", () => {
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "running",
      health: "ok",
      phase: "blocked",
    }),
    { kind: "noop" }
  )
})

test("decision: malformed snapshot (missing fields) → noop, never crashes", () => {
  assert.deepEqual(decideRuntimeUpdateAction({}), { kind: "noop" })
  assert.deepEqual(
    decideRuntimeUpdateAction({ laneState: null, phase: undefined }),
    { kind: "noop" }
  )
})

test("decision: error takes precedence over completion", () => {
  // If a snapshot somehow has laneState=idle but health=error, treat as
  // failure not success — the user should see the error, not a green check.
  assert.deepEqual(
    decideRuntimeUpdateAction({
      laneState: "idle",
      health: "error",
      phase: "idle",
    }),
    { kind: "terminal-error" }
  )
})
