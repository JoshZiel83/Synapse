import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { waitForAuthenticated } from "./client.js"
import type { WecomClient } from "./client.js"

function fakeClient(): { client: WecomClient; emitter: EventEmitter } {
  // The SDK's WSClient extends EventEmitter. We can stand in a plain
  // EventEmitter that implements `once` / `off` (Node's EventEmitter
  // has both) — TS just needs an assertion.
  const emitter = new EventEmitter()
  return { client: emitter as unknown as WecomClient, emitter }
}

test("waitForAuthenticated resolves on 'authenticated' event", async () => {
  const { client, emitter } = fakeClient()
  const waitP = waitForAuthenticated(client, 5_000)
  emitter.emit("authenticated")
  await waitP // should resolve, not reject
})

test("waitForAuthenticated rejects after timeout when no auth event", async () => {
  const { client } = fakeClient()
  await assert.rejects(
    () => waitForAuthenticated(client, 50),
    /wecom auth timeout/
  )
})

test("waitForAuthenticated does NOT reject on 'error' event (lets SDK retry)", async () => {
  const { client, emitter } = fakeClient()
  // EventEmitter throws on unhandled 'error' by default — in production the
  // connector registers a real error handler before calling
  // waitForAuthenticated. Mirror that here so emit('error') doesn't crash.
  emitter.on("error", () => {})
  const waitP = waitForAuthenticated(client, 200)
  // Emit error twice and then authenticate before the 200ms deadline.
  // Old behavior would have rejected on the first error; the v1 contract
  // is to ignore errors during the auth window so SDK reconnect can succeed.
  emitter.emit("error", new Error("transient network blip"))
  emitter.emit("error", new Error("transient network blip 2"))
  setTimeout(() => emitter.emit("authenticated"), 30)
  await waitP // must resolve, not throw
})

test("waitForAuthenticated cleans up listener after resolve", async () => {
  const { client, emitter } = fakeClient()
  const before = emitter.listenerCount("authenticated")
  const waitP = waitForAuthenticated(client, 200)
  assert.equal(emitter.listenerCount("authenticated"), before + 1)
  emitter.emit("authenticated")
  await waitP
  assert.equal(emitter.listenerCount("authenticated"), before)
})

test("waitForAuthenticated cleans up listener after timeout", async () => {
  const { client, emitter } = fakeClient()
  const before = emitter.listenerCount("authenticated")
  await assert.rejects(() => waitForAuthenticated(client, 50))
  assert.equal(emitter.listenerCount("authenticated"), before)
})
