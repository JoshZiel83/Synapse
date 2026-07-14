// Off-box orphan-sweep + keepalive ORCHESTRATION unit tests (R4 §1.7 / #3).
//
// The provenance/grace/diff logic lives in the adapter (cubesandbox/orphan-sweep
// .test.ts). Here we pin the SERVICE orchestration: it must be per-resource
// fault-tolerant (one destroy/refresh failure never aborts the batch), no-op for
// a non-off-box / absent adapter, and thread the live active-set into listOrphans.

import test from "node:test"
import assert from "node:assert/strict"

import {
  reapOffBoxSandboxOrphans,
  keepAliveOffBoxSandboxes,
} from "./service.js"
import type { Executor } from "./repo.js"
import type { OrphanResource, SandboxAdapter } from "./adapter-registry.js"

/** Minimal off-box adapter stub exposing only the orphan/keepalive seams. */
function offBoxAdapter(overrides: {
  tag?: string
  offBox?: boolean
  listOrphans?: SandboxAdapter["listOrphans"]
  destroyResource?: SandboxAdapter["destroyResource"]
  refreshResourceDeadline?: SandboxAdapter["refreshResourceDeadline"]
}): SandboxAdapter {
  const offBox = overrides.offBox ?? true
  return {
    key: `${overrides.tag ?? "cubesandbox"}:bare`,
    // (#13) the discriminant configuredOffBoxAdapter now narrows on.
    kind: offBox ? "offBoxBare" : "hostBare",
    meta: {
      tag: overrides.tag ?? "cubesandbox",
      offBox,
    },
    listOrphans: overrides.listOrphans,
    destroyResource: overrides.destroyResource,
    refreshResourceDeadline: overrides.refreshResourceDeadline,
  } as unknown as SandboxAdapter
}

const NO_EXEC = undefined as unknown as Executor

test("reapOffBoxSandboxOrphans: destroys every reported orphan", async () => {
  const destroyed: string[] = []
  const adapter = offBoxAdapter({
    listOrphans: async () =>
      [{ resourceId: "a" }, { resourceId: "b" }] as OrphanResource[],
    destroyResource: async (id) => {
      destroyed.push(id)
    },
  })
  const res = await reapOffBoxSandboxOrphans({
    adapter,
    executor: NO_EXEC,
    listActiveResourceIds: async () => [],
  })
  assert.deepEqual(res, { scanned: 2, reaped: 2 })
  assert.deepEqual(destroyed.sort(), ["a", "b"])
})

test("reapOffBoxSandboxOrphans: one destroy failure does not abort the batch", async () => {
  const destroyed: string[] = []
  const adapter = offBoxAdapter({
    listOrphans: async () =>
      [
        { resourceId: "ok1" },
        { resourceId: "boom" },
        { resourceId: "ok2" },
      ] as OrphanResource[],
    destroyResource: async (id) => {
      if (id === "boom") throw new Error("stuck paused VM (500)")
      destroyed.push(id)
    },
  })
  const res = await reapOffBoxSandboxOrphans({
    adapter,
    executor: NO_EXEC,
    listActiveResourceIds: async () => [],
  })
  assert.equal(res.scanned, 3)
  assert.equal(res.reaped, 2, "the two healthy destroys still succeed")
  assert.deepEqual(destroyed.sort(), ["ok1", "ok2"])
})

test("reapOffBoxSandboxOrphans: threads the live active-set into listOrphans", async () => {
  let seen: ReadonlySet<string> | null = null
  const adapter = offBoxAdapter({
    listOrphans: async ({ activeResourceIds }) => {
      seen = activeResourceIds
      return []
    },
    destroyResource: async () => {},
  })
  await reapOffBoxSandboxOrphans({
    adapter,
    executor: NO_EXEC,
    listActiveResourceIds: async (tag) => {
      assert.equal(tag, "cubesandbox", "queries the adapter's persisted tag")
      return ["live-1", "live-2"]
    },
  })
  assert.deepEqual([...(seen ?? new Set())].sort(), ["live-1", "live-2"])
})

test("reapOffBoxSandboxOrphans: a listing failure reaps nothing (fail-safe)", async () => {
  let destroyCalls = 0
  const adapter = offBoxAdapter({
    listOrphans: async () => {
      throw new Error("control plane unreachable")
    },
    destroyResource: async () => {
      destroyCalls += 1
    },
  })
  const res = await reapOffBoxSandboxOrphans({
    adapter,
    executor: NO_EXEC,
    listActiveResourceIds: async () => [],
  })
  assert.deepEqual(res, { scanned: 0, reaped: 0 })
  assert.equal(destroyCalls, 0, "never destroys when the listing failed")
})

test("reapOffBoxSandboxOrphans: no-op for a non-off-box adapter", async () => {
  let called = false
  const adapter = offBoxAdapter({
    offBox: false,
    listOrphans: async () => {
      called = true
      return [{ resourceId: "x" }]
    },
    destroyResource: async () => {},
  })
  const res = await reapOffBoxSandboxOrphans({ adapter, executor: NO_EXEC })
  assert.deepEqual(res, { scanned: 0, reaped: 0 })
  assert.equal(called, false)
})

test("reapOffBoxSandboxOrphans: no-op for an absent adapter", async () => {
  const res = await reapOffBoxSandboxOrphans({
    adapter: null,
    executor: NO_EXEC,
  })
  assert.deepEqual(res, { scanned: 0, reaped: 0 })
})

test("keepAliveOffBoxSandboxes: refreshes every in-use VM's deadline", async () => {
  const refreshed: string[] = []
  const adapter = offBoxAdapter({
    refreshResourceDeadline: async (id) => {
      refreshed.push(id)
    },
  })
  const res = await keepAliveOffBoxSandboxes({
    adapter,
    executor: NO_EXEC,
    listInUseResourceIds: async () => ["s1", "s2", "s3"],
  })
  assert.deepEqual(res, { refreshed: 3, failed: 0 })
  assert.deepEqual(refreshed.sort(), ["s1", "s2", "s3"])
})

test("keepAliveOffBoxSandboxes: one refresh failure is counted, the rest proceed", async () => {
  const refreshed: string[] = []
  const adapter = offBoxAdapter({
    refreshResourceDeadline: async (id) => {
      if (id === "bad") throw new Error("gone")
      refreshed.push(id)
    },
  })
  const res = await keepAliveOffBoxSandboxes({
    adapter,
    executor: NO_EXEC,
    listInUseResourceIds: async () => ["ok", "bad", "ok2"],
  })
  assert.deepEqual(res, { refreshed: 2, failed: 1 })
  assert.deepEqual(refreshed.sort(), ["ok", "ok2"])
})

test("keepAliveOffBoxSandboxes: no-op for a non-off-box adapter", async () => {
  const res = await keepAliveOffBoxSandboxes({
    adapter: offBoxAdapter({
      offBox: false,
      refreshResourceDeadline: async () => {},
    }),
    executor: NO_EXEC,
  })
  assert.deepEqual(res, { refreshed: 0, failed: 0 })
})
