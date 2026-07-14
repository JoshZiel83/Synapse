// cubesandbox:bare orphan-enumeration unit tests (R4 §1.7 / #3).
//
// listOrphans is the provider half of the orphan sweep: it lists ALL cube VMs
// (the dev deployment ignores metadata query filters, verified live) and reports
// only those that are (a) OURS by provenance tag, (b) NOT tracked by a live DB
// row, and (c) older than the create→mint race grace. These tests pin all three
// gates plus the destroy/keepalive seams — the fail-safe direction of each gate
// matters (a wrongly-reaped VM is data loss).

import test from "node:test"
import assert from "node:assert/strict"

import { makeCubesandboxBareAdapter } from "../cubesandbox-adapter.js"
import type { CubesandboxBareOptions } from "../cubesandbox-adapter.js"
import type { CubeControlClient } from "./control-client.js"
import {
  SYNAPSE_DEPLOYMENT_ID_KEY,
  SYNAPSE_RUNTIME_ID_KEY,
  type SandboxListEntry,
} from "./types.js"

const OPTS: CubesandboxBareOptions = {
  apiUrl: "http://127.0.0.1:13000",
  proxyUrl: "http://127.0.0.1:11080",
  domain: "cube.app",
  template: "tpl-test",
  vmRoot: "/workspace",
  envdPort: 49983,
  sandboxTtlSeconds: 1800,
  deploymentId: "",
}

interface ControlSink {
  killed: string[]
  timeouts: Array<[string, number]>
}

function fakeControl(
  list: SandboxListEntry[],
  sink: ControlSink,
  listImpl?: () => Promise<SandboxListEntry[]>
): CubeControlClient {
  return {
    list: listImpl ?? (async () => list),
    kill: async (id: string) => {
      sink.killed.push(id)
    },
    setTimeout: async (id: string, seconds: number) => {
      sink.timeouts.push([id, seconds])
    },
  } as unknown as CubeControlClient
}

function adapterWith(control: CubeControlClient) {
  return makeCubesandboxBareAdapter({
    optionsOverride: OPTS,
    controlClientFactory: () => control,
  })
}

/** A provenance-tagged list entry `age` ms in the past. */
function ours(id: string, ageMs: number): SandboxListEntry {
  return {
    sandboxID: id,
    state: "running",
    startedAt: new Date(Date.now() - ageMs).toISOString(),
    metadata: { [SYNAPSE_RUNTIME_ID_KEY]: `rt-${id}` },
  }
}

const GRACE = 600_000 // 10 min

test("listOrphans: a tagged, untracked, OLD VM is reported as an orphan", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const adapter = adapterWith(fakeControl([ours("vm-old", 20 * 60_000)], sink))
  const orphans = await adapter.listOrphans!({
    activeResourceIds: new Set<string>(),
    minAgeMs: GRACE,
  })
  assert.deepEqual(
    orphans.map((o) => o.resourceId),
    ["vm-old"]
  )
})

test("listOrphans: a foreign (UNtagged) VM is never reported, even if old + untracked", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const foreign: SandboxListEntry = {
    sandboxID: "vm-foreign",
    state: "running",
    startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    metadata: { "some.other.tool": "yes" },
  }
  const adapter = adapterWith(fakeControl([foreign], sink))
  const orphans = await adapter.listOrphans!({
    activeResourceIds: new Set<string>(),
    minAgeMs: GRACE,
  })
  assert.deepEqual(orphans, [])
})

test("listOrphans: a tagged VM tracked by a live DB row is not an orphan", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const adapter = adapterWith(fakeControl([ours("vm-live", 20 * 60_000)], sink))
  const orphans = await adapter.listOrphans!({
    activeResourceIds: new Set(["vm-live"]),
    minAgeMs: GRACE,
  })
  assert.deepEqual(orphans, [])
})

test("listOrphans: a tagged, untracked, YOUNG VM is spared (create→mint race grace)", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const adapter = adapterWith(fakeControl([ours("vm-young", 60_000)], sink))
  const orphans = await adapter.listOrphans!({
    activeResourceIds: new Set<string>(),
    minAgeMs: GRACE,
  })
  assert.deepEqual(orphans, [], "a 1-min-old VM is inside the 10-min grace")
})

test("listOrphans: an unparseable/absent startedAt is treated as too-young (fail-safe)", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const noStart: SandboxListEntry = {
    sandboxID: "vm-nostart",
    state: "running",
    metadata: { [SYNAPSE_RUNTIME_ID_KEY]: "rt-x" },
  }
  const adapter = adapterWith(fakeControl([noStart], sink))
  const orphans = await adapter.listOrphans!({
    activeResourceIds: new Set<string>(),
    minAgeMs: GRACE,
  })
  assert.deepEqual(
    orphans,
    [],
    "unknown age must NOT be reaped by the sweep (the TTL is its backstop)"
  )
})

test("listOrphans: mixed batch reports exactly the old-untracked-ours set", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const entries: SandboxListEntry[] = [
    ours("vm-a", 20 * 60_000), // old, untracked, ours → orphan
    ours("vm-b", 20 * 60_000), // old but TRACKED → spared
    ours("vm-c", 60_000), // young → spared
    {
      sandboxID: "vm-d",
      state: "paused",
      startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      metadata: {},
    }, // untagged → spared
  ]
  const adapter = adapterWith(fakeControl(entries, sink))
  const orphans = await adapter.listOrphans!({
    activeResourceIds: new Set(["vm-b"]),
    minAgeMs: GRACE,
  })
  assert.deepEqual(orphans.map((o) => o.resourceId).sort(), ["vm-a"])
})

test("destroyResource kills exactly the given resource id (idempotent seam)", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const adapter = adapterWith(fakeControl([], sink))
  await adapter.destroyResource!("vm-kill")
  assert.deepEqual(sink.killed, ["vm-kill"])
})

test("refreshResourceDeadline pushes the deadline forward by the configured TTL", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const adapter = adapterWith(fakeControl([], sink))
  await adapter.refreshResourceDeadline!("vm-keepalive")
  assert.deepEqual(sink.timeouts, [["vm-keepalive", 1800]])
})

// ── #12c: deployment-scoped orphan reaping ───────────────────────────────────
// Two deployments sharing ONE Cube account each stamp their own deployment id.
// The sweep must reap only VMs whose deployment id matches THIS deployment's, so a
// sibling deployment's VMs are never cross-reaped, while replicas of the SAME
// deployment (shared id) still clean up for each other.

function adapterWithDeployment(
  control: CubeControlClient,
  deploymentId: string
) {
  return makeCubesandboxBareAdapter({
    optionsOverride: { ...OPTS, deploymentId },
    controlClientFactory: () => control,
  })
}

/** A provenance-tagged entry `age` ms old, stamped with a specific deployment id. */
function oursForDeployment(
  id: string,
  ageMs: number,
  deploymentId: string
): SandboxListEntry {
  return {
    sandboxID: id,
    state: "running",
    startedAt: new Date(Date.now() - ageMs).toISOString(),
    metadata: {
      [SYNAPSE_RUNTIME_ID_KEY]: `rt-${id}`,
      ...(deploymentId ? { [SYNAPSE_DEPLOYMENT_ID_KEY]: deploymentId } : {}),
    },
  }
}

test("listOrphans: a configured deployment reaps only its OWN deployment's VMs", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const entries: SandboxListEntry[] = [
    oursForDeployment("vm-mine", 20 * 60_000, "dep-A"), // old, ours → orphan
    oursForDeployment("vm-sibling", 20 * 60_000, "dep-B"), // sibling deploy → spared
    ours("vm-unmarked", 20 * 60_000), // no deployment marker → spared (!= "dep-A")
  ]
  const adapter = adapterWithDeployment(fakeControl(entries, sink), "dep-A")
  const orphans = await adapter.listOrphans!({
    activeResourceIds: new Set<string>(),
    minAgeMs: GRACE,
  })
  assert.deepEqual(orphans.map((o) => o.resourceId).sort(), ["vm-mine"])
})

test("listOrphans: an UNSET deployment id reaps unmarked VMs but spares a marked sibling", async () => {
  const sink: ControlSink = { killed: [], timeouts: [] }
  const entries: SandboxListEntry[] = [
    ours("vm-unmarked", 20 * 60_000), // no marker, our (empty) owner → orphan
    oursForDeployment("vm-sibling", 20 * 60_000, "dep-B"), // marked sibling → spared
  ]
  const adapter = adapterWithDeployment(fakeControl(entries, sink), "")
  const orphans = await adapter.listOrphans!({
    activeResourceIds: new Set<string>(),
    minAgeMs: GRACE,
  })
  assert.deepEqual(orphans.map((o) => o.resourceId).sort(), ["vm-unmarked"])
})
