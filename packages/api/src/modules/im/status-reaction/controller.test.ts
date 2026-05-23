import test from "node:test"
import assert from "node:assert/strict"
import { createFakeClock } from "../../../test-utils/fake-clock.js"
import { createRecordingStatusAdapter } from "../../../test-utils/recording-adapter.js"
import { createStatusReactionController } from "./controller.js"

test("controller drives full lifecycle: queued → thinking → done → clear", async () => {
  const clock = createFakeClock()
  const adapter = createRecordingStatusAdapter(() => clock.now())
  const c = createStatusReactionController({
    adapter,
    clock,
    config: { debounceMs: 100, doneHoldMs: 200, errorHoldMs: 500 },
  })

  c.set("queued")
  // Debounce
  clock.advance(110)
  // Let microtask queue drain
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  c.set("thinking") // queued for after queued finishes
  await Promise.resolve()
  await Promise.resolve()
  clock.advance(120) // any pending debounce tick fires
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  c.done()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  // Allow done hold to elapse and clear to fire
  clock.advance(210)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await c.destroy()

  const setOps = adapter.ops
    .filter((o) => o.kind === "set")
    .map((o) => (o.kind === "set" ? o.emoji : ""))
  // We expect at minimum queued and done in the sequence
  assert.ok(setOps.includes("👀"), `expected 👀 in ${JSON.stringify(setOps)}`)
  assert.ok(setOps.includes("✅"), `expected ✅ in ${JSON.stringify(setOps)}`)
})

test("controller returns NULL_CONTROLLER when adapter is null", async () => {
  const c = createStatusReactionController({ adapter: null })
  c.set("thinking")
  c.done()
  await c.destroy()
  // No throw, no ops to record
  assert.equal(c.inspect().pendingTimers, 0)
})

test("destroy cancels pending timers even mid-pending", async () => {
  const clock = createFakeClock()
  const adapter = createRecordingStatusAdapter(() => clock.now())
  const c = createStatusReactionController({ adapter, clock })

  c.set("thinking")
  assert.ok(c.inspect().pendingTimers > 0)
  await c.destroy()
  assert.equal(c.inspect().pendingTimers, 0)
  // No setReaction ever fired because we destroyed before the debounce expired
  assert.equal(adapter.ops.filter((o) => o.kind === "set").length, 0)
})

test("error path: adapter failure invokes onError and exits in-flight", async () => {
  const clock = createFakeClock()
  const adapter = createRecordingStatusAdapter(() => clock.now())
  adapter.nextFailure = new Error("network")
  const errors: unknown[] = []

  const c = createStatusReactionController({
    adapter,
    clock,
    config: {
      debounceMs: 50,
      doneHoldMs: 50,
      errorHoldMs: 50,
      stallSoftMs: 10000,
      stallHardMs: 30000,
    },
    onError: (e) => errors.push(e),
  })

  c.set("thinking")
  clock.advance(60)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await c.destroy()

  assert.equal(errors.length, 1)
  assert.equal((errors[0] as Error).message, "network")
  // No "set" ops recorded because the throw prevented the push
  assert.equal(adapter.ops.filter((o) => o.kind === "set").length, 0)
})
