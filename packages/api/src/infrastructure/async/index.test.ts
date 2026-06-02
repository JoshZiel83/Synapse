import test from "node:test"
import assert from "node:assert/strict"
import { sleep, withTimeout } from "./index.js"

test("sleep resolves after the delay", async () => {
  const start = Date.now()
  await sleep(30)
  assert.ok(Date.now() - start >= 25)
})

test("sleep resolves early (no throw) when the signal aborts", async () => {
  const ac = new AbortController()
  const p = sleep(10_000, ac.signal)
  ac.abort()
  await p // must resolve, not reject
})

test("sleep returns immediately if signal already aborted", async () => {
  const ac = new AbortController()
  ac.abort()
  const start = Date.now()
  await sleep(10_000, ac.signal)
  assert.ok(Date.now() - start < 100)
})

test("withTimeout resolves when the promise is fast enough", async () => {
  const result = await withTimeout(Promise.resolve(42), 1000, "fast")
  assert.equal(result, 42)
})

test("withTimeout rejects with a labelled error when slow", async () => {
  // A promise that settles on its own well after the timeout, so nothing is
  // left dangling for the test runner.
  const slow = sleep(200).then(() => 1)
  await assert.rejects(
    () => withTimeout(slow, 20, "slow-op"),
    /slow-op timed out after 20ms/
  )
  await slow // let it settle
})

test("withTimeout passes the promise through when ms <= 0", async () => {
  const result = await withTimeout(Promise.resolve("x"), 0)
  assert.equal(result, "x")
})
