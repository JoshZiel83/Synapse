// GROUP G — working-set bridges (S11 product path, S12 detached remote bridge)
// + the forced-commit-failure stash contract. DB-FREE: the detached bridge is
// driven through an injected `docker exec` seam (the CI PROOF of the exact remote
// bridge contract envd will implement) — Removes delete-propagation, tmp+Move
// writes, and the (size,mtime) stat-cache. No :5432 / :55632, no real daemon.

import test from "node:test"
import assert from "node:assert/strict"
import {
  createProductWorkingSetBridge,
  createDetachedWorkingSetBridge,
  makeDockerExecTransport,
  planReplication,
  reconcileStatCache,
  parseFindListing,
  stashUncommittedWorkingSet,
  type ContainerFileStat,
  type DockerExecFn,
  type StatCache,
  type WorkingSetTransport,
} from "./working-set-bridge.js"

// ─────────────────────────── S11 product bridge ──────────────────────────────

test("S11 — the product bridge exposes the WorkingSetBridge contract (pure spine delegation)", () => {
  const bridge = createProductWorkingSetBridge()
  assert.equal(typeof bridge.applyManifest, "function")
  assert.equal(typeof bridge.scanManifest, "function")
})

// ─────────────────────────── S12 pure planners ───────────────────────────────

test("S12 — planReplication propagates DELETES (container file absent from mirror → Remove)", () => {
  const plan = planReplication(
    ["/conversation/a.py", "/conversation/b.py"],
    ["/conversation/a.py", "/conversation/gone.py"]
  )
  assert.deepEqual(plan.writes, ["/conversation/a.py", "/conversation/b.py"])
  assert.deepEqual(
    plan.removes,
    ["/conversation/gone.py"],
    "a file no longer in the mirror is explicitly removed in-container"
  )
})

test("S12 — reconcileStatCache reuses a (size,mtime) match, fetches a mismatch/miss", () => {
  const cache: StatCache = new Map([
    ["/c/a", { size: 10, mtimeSec: 100, sha256: "sha-a" }],
    ["/c/b", { size: 20, mtimeSec: 200, sha256: "sha-b" }],
  ])
  const { reused, toFetch } = reconcileStatCache(
    [
      { relpath: "/c/a", size: 10, mtimeSec: 100 }, // exact match → reuse
      { relpath: "/c/b", size: 20, mtimeSec: 201 }, // mtime changed → fetch
      { relpath: "/c/new", size: 5, mtimeSec: 5 }, // miss → fetch
    ],
    cache
  )
  assert.deepEqual(
    reused.map((r) => r.sha256),
    ["sha-a"]
  )
  assert.deepEqual(toFetch.sort(), ["/c/b", "/c/new"])
})

test("S12 — parseFindListing parses `%s %T@ %p` rows (truncated mtime)", () => {
  const rows = parseFindListing(
    "12 1700000000.5 /conversation/x.py\n34 1700000009.9 /actor/y.txt\n\n"
  )
  assert.deepEqual(rows, [
    { relpath: "/conversation/x.py", size: 12, mtimeSec: 1700000000 },
    { relpath: "/actor/y.txt", size: 34, mtimeSec: 1700000009 },
  ])
})

// ─────────────────────────── S12 detached bridge ─────────────────────────────

function recordingExec(scripts: {
  find?: string
  cat?: Record<string, string>
}): { exec: DockerExecFn; calls: Array<{ argv: string[]; stdin?: string }> } {
  const calls: Array<{ argv: string[]; stdin?: string }> = []
  const exec: DockerExecFn = async (argv, opts) => {
    calls.push({
      argv,
      stdin: opts?.stdin ? opts.stdin.toString("binary") : undefined,
    })
    if (argv.includes("find")) {
      return { code: 0, stdout: scripts.find ?? "", stderr: "" }
    }
    if (argv[2] === "cat") {
      const path = argv[3]!
      return { code: 0, stdout: scripts.cat?.[path] ?? "", stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { exec, calls }
}

test("S12 — applyManifest replicates via tmp+Move and propagates Removes (never docker cp/tar)", async () => {
  // Container currently holds a.py + stale.py; the mirror holds a.py + b.py.
  const { exec, calls } = recordingExec({
    find: "1 100 /conversation/a.py\n1 100 /conversation/stale.py\n",
  })
  const bridge = createDetachedWorkingSetBridge({
    mirrorDir: "/tmp/mirror",
    mountRoots: ["/conversation"],
    transport: makeDockerExecTransport({ containerId: "cid", exec }),
    statCache: new Map(),
    listMirrorFiles: async () => ["/conversation/a.py", "/conversation/b.py"],
    readMirrorFile: async (rel) => Buffer.from(`bytes:${rel}`),
  })
  await bridge.applyManifest({
    manifestSha256: undefined,
    targetDir: "/tmp/mirror",
  })

  // No docker cp / tar EVER.
  for (const c of calls) {
    assert.ok(!c.argv.includes("cp"), "never docker cp")
    assert.ok(!c.argv.some((a) => a === "tar"), "never tar -x")
  }
  // Writes go tmp-then-Move: `cat > '<rel>.synapse-tmp'` then `mv -f <tmp> <rel>`.
  const wroteTmp = calls.filter((c) =>
    c.argv.some((a) => a.includes(".synapse-tmp") && a.startsWith("cat >"))
  )
  assert.equal(wroteTmp.length, 2, "two files written via tmp")
  assert.ok(
    calls.some(
      (c) =>
        c.argv[2] === "mv" &&
        c.argv[4] === "/conversation/a.py.synapse-tmp" &&
        c.argv[5] === "/conversation/a.py"
    ),
    "a.py is Moved into place"
  )
  // Delete-propagation: stale.py (absent from the mirror) is removed in-container.
  assert.ok(
    calls.some(
      (c) => c.argv[2] === "rm" && c.argv.includes("/conversation/stale.py")
    ),
    "stale.py is explicitly Removed (delete-propagation)"
  )
})

test("S12 — fetchChangedIntoMirror cats ONLY the stat-cache-mismatched file (the envd stat-cache contract)", async () => {
  const cache: StatCache = new Map([
    ["/conversation/keep.py", { size: 3, mtimeSec: 100, sha256: "cached" }],
  ])
  const { exec, calls } = recordingExec({
    // keep.py unchanged (3,100); changed.py new.
    find: "3 100 /conversation/keep.py\n7 200 /conversation/changed.py\n",
    cat: { "/conversation/changed.py": "new-bytes" },
  })
  const written: Record<string, string> = {}
  const bridge = createDetachedWorkingSetBridge({
    mirrorDir: "/tmp/mirror",
    mountRoots: ["/conversation"],
    transport: makeDockerExecTransport({ containerId: "cid", exec }),
    statCache: cache,
    writeMirrorFile: async (rel, bytes) => {
      written[rel] = bytes.toString("binary")
    },
  })
  const res = await bridge.fetchChangedIntoMirror()
  assert.deepEqual(res.fetched, ["/conversation/changed.py"])
  assert.deepEqual(res.reused, ["/conversation/keep.py"])
  // ONLY the changed file was cat'd (keep.py was reused from the stat-cache).
  const cats = calls.filter((c) => c.argv[2] === "cat").map((c) => c.argv[3])
  assert.deepEqual(cats, ["/conversation/changed.py"])
  // The cache now carries changed.py's fresh sha.
  assert.ok(cache.get("/conversation/changed.py"))
  assert.equal(written["/conversation/changed.py"], "new-bytes")
})

// ─────────────────────── S12 forced-commit-failure stash ──────────────────────

test("S12 — stashUncommittedWorkingSet exfiltrates + records the stash manifest (commit-failure recovery WRITE contract)", async () => {
  const { exec } = recordingExec({
    find: "7 200 /conversation/wip.py\n",
    cat: { "/conversation/wip.py": "uncommitted" },
  })
  const bridge = createDetachedWorkingSetBridge({
    mirrorDir: "/tmp/mirror",
    mountRoots: ["/conversation"],
    transport: makeDockerExecTransport({ containerId: "cid", exec }),
    statCache: new Map(),
    writeMirrorFile: async () => {},
  })
  let recorded: string | null = null
  const res = await stashUncommittedWorkingSet({
    bridge,
    mirrorDir: "/tmp/mirror",
    // Stub the CAS commit (the real path runs scanCommitDir on the mirror).
    scanManifest: async () => ({ mergedManifestSha256: "stash-manifest-sha" }),
    recordStash: async (sha) => {
      recorded = sha
    },
  })
  assert.equal(res.stashed, true)
  assert.equal(res.manifestSha256, "stash-manifest-sha")
  assert.equal(
    recorded,
    "stash-manifest-sha",
    "stash pointer recorded as GC root"
  )
})

test("S12 — stash is a clean no-op when the exfiltrate/commit yields no manifest", async () => {
  const { exec } = recordingExec({ find: "" })
  const bridge = createDetachedWorkingSetBridge({
    mirrorDir: "/tmp/mirror",
    mountRoots: ["/conversation"],
    transport: makeDockerExecTransport({ containerId: "cid", exec }),
    statCache: new Map(),
  })
  let recordCalls = 0
  const res = await stashUncommittedWorkingSet({
    bridge,
    mirrorDir: "/tmp/mirror",
    scanManifest: async () => ({}),
    recordStash: async () => {
      recordCalls += 1
    },
  })
  assert.equal(res.stashed, false)
  assert.equal(recordCalls, 0)
})

// ─────────────────────── R4: F1 pull delete-prune (P0) ───────────────────────

/**
 * An in-memory WorkingSetTransport (the VM) + an in-memory mirror, so the
 * delete-aware-mirror + stat-cache + prune logic is testable transport-agnostically
 * (no docker exec, no envd, no fs-helper). Keys are VFS-mount-rooted.
 */
function inMemoryVm(
  initial: Record<string, { bytes: string; mtimeKey: string }> = {}
): {
  transport: WorkingSetTransport
  vm: Map<string, { bytes: Buffer; mtimeKey: string }>
} {
  const vm = new Map<string, { bytes: Buffer; mtimeKey: string }>()
  for (const [rel, v] of Object.entries(initial)) {
    vm.set(rel, { bytes: Buffer.from(v.bytes), mtimeKey: v.mtimeKey })
  }
  const transport: WorkingSetTransport = {
    async list(mountRoots) {
      const out: ContainerFileStat[] = []
      for (const [rel, v] of vm) {
        if (!mountRoots.some((r) => rel === r || rel.startsWith(`${r}/`)))
          continue
        out.push({
          relpath: rel,
          size: v.bytes.length,
          mtimeSec: Math.trunc(Number(v.mtimeKey) / 1000),
          mtimeKey: v.mtimeKey,
        })
      }
      return out
    },
    async read(rel) {
      return vm.get(rel)?.bytes ?? Buffer.alloc(0)
    },
    async write(rel, bytes) {
      vm.set(rel, { bytes, mtimeKey: String(Date.now() + vm.size) })
    },
    async remove(rel) {
      vm.delete(rel)
    },
  }
  return { transport, vm }
}

/** In-memory mirror injected into the detached bridge. */
function inMemoryMirror(seed: Record<string, string> = {}): {
  mirror: Map<string, Buffer>
  helpers: Pick<
    Parameters<typeof createDetachedWorkingSetBridge>[0],
    | "readMirrorFile"
    | "writeMirrorFile"
    | "listMirrorFiles"
    | "removeMirrorFile"
  >
} {
  const mirror = new Map<string, Buffer>()
  for (const [rel, v] of Object.entries(seed)) mirror.set(rel, Buffer.from(v))
  return {
    mirror,
    helpers: {
      readMirrorFile: async (rel) => mirror.get(rel) ?? Buffer.alloc(0),
      writeMirrorFile: async (rel, bytes) => {
        mirror.set(rel, bytes)
      },
      listMirrorFiles: async () => [...mirror.keys()],
      removeMirrorFile: async (rel) => {
        mirror.delete(rel)
      },
    },
  }
}

test("R4 F1 — delete-in-VM → pull PRUNES the mirror (a VM-deleted file does not resurrect from base)", async () => {
  // Mirror holds the base (keep + gone); the VM listing NO LONGER has gone.py.
  const { transport } = inMemoryVm({
    "/conversation/keep.py": { bytes: "keep", mtimeKey: "1000" },
    // gone.py deleted in the VM — absent from the listing.
  })
  const { mirror, helpers } = inMemoryMirror({
    "/conversation/keep.py": "keep",
    "/conversation/gone.py": "gone-base", // stale base copy that MUST be pruned
  })
  const statCache: StatCache = new Map()
  const bridge = createDetachedWorkingSetBridge({
    mirrorDir: "/mirror/conversation",
    mountRoots: ["/conversation"],
    transport,
    statCache,
    ...helpers,
  })
  const res = await bridge.fetchChangedIntoMirror()
  assert.deepEqual(
    res.pruned,
    ["/conversation/gone.py"],
    "the VM-deleted file is pruned from the mirror"
  )
  assert.equal(
    mirror.has("/conversation/gone.py"),
    false,
    "gone.py no longer in the mirror → the following commit scan propagates the delete"
  )
  assert.equal(mirror.has("/conversation/keep.py"), true, "keep.py survives")
})

// ─────────────────────── R4: F6 full-ms stat-cache key ───────────────────────

test("R4 F6 — a same-size same-SECOND in-place edit is NOT a false cache hit (envd full-ms key)", () => {
  // Cached at ms=1700000000_100; the VM re-wrote it at ms=1700000000_900 — SAME
  // second (1700000000), same size. The docker `%T@` second-key would falsely
  // reuse the stale sha (lost update); the full-ms key must FETCH.
  const cache: StatCache = new Map([
    [
      "/conversation/x.py",
      {
        size: 5,
        mtimeSec: 1700000000,
        mtimeKey: "1700000000100",
        sha256: "old",
      },
    ],
  ])
  const { toFetch, reused } = reconcileStatCache(
    [
      {
        relpath: "/conversation/x.py",
        size: 5,
        mtimeSec: 1700000000, // SAME truncated second as the cache
        mtimeKey: "1700000000900", // DIFFERENT full-ms → must fetch
      },
    ],
    cache
  )
  assert.deepEqual(
    toFetch,
    ["/conversation/x.py"],
    "same-second in-place edit is re-fetched, not falsely reused"
  )
  assert.equal(reused.length, 0)
})

test("R4 F6 — docker (no mtimeKey) keeps its (size, second) key unchanged", () => {
  const cache: StatCache = new Map([
    ["/c/a", { size: 10, mtimeSec: 100, sha256: "sha-a" }],
  ])
  const { reused, toFetch } = reconcileStatCache(
    [{ relpath: "/c/a", size: 10, mtimeSec: 100 }], // no mtimeKey → second-key path
    cache
  )
  assert.deepEqual(
    reused.map((r) => r.sha256),
    ["sha-a"],
    "docker second-granularity reuse is preserved (no mtimeKey on either side)"
  )
  assert.deepEqual(toFetch, [])
})

// ───────────────── R4: full-turn round-trip (base→push→edit→pull) ─────────────

test("R4 — full-turn round-trip: base→push→edit-in-VM(+delete+create)→pull → mirror reflects edit+delete+create", async () => {
  // ① base materialized into the mirror (line-937 equivalent).
  const { transport, vm } = inMemoryVm()
  const { mirror, helpers } = inMemoryMirror({
    "/conversation/keep.py": "base-keep",
    "/conversation/gone.py": "base-gone",
  })
  const statCache: StatCache = new Map()
  const bridge = createDetachedWorkingSetBridge({
    mirrorDir: "/mirror/conversation",
    mountRoots: ["/conversation"],
    transport,
    statCache,
    ...helpers,
  })

  // ② PUSH base INTO the (empty) VM — planReplication writes all, removes none.
  const plan = await bridge.planFor([...mirror.keys()])
  assert.deepEqual(plan.writes, [
    "/conversation/gone.py",
    "/conversation/keep.py",
  ])
  assert.deepEqual(plan.removes, [])
  for (const rel of plan.writes)
    await transport.write(rel, mirror.get(rel) ?? Buffer.alloc(0))
  assert.equal(vm.size, 2, "base is now in the VM")

  // ③ the turn runs IN the VM: edit keep.py, delete gone.py, create new.py.
  await transport.write("/conversation/keep.py", Buffer.from("EDITED-in-vm"))
  await transport.remove("/conversation/gone.py")
  await transport.write("/conversation/new.py", Buffer.from("created-in-vm"))

  // ④ PULL VM→mirror (fetch changed + F1 prune).
  const pull = await bridge.fetchChangedIntoMirror()
  assert.deepEqual(
    pull.pruned,
    ["/conversation/gone.py"],
    "the VM-deleted file is pruned from the mirror"
  )

  // ⑤ the mirror (what the following commit scan snapshots) now EXACTLY mirrors
  //    the VM working set: edit applied, delete propagated, create present.
  assert.equal(
    mirror.get("/conversation/keep.py")?.toString(),
    "EDITED-in-vm",
    "edit round-trips into the mirror (would appear in the next base)"
  )
  assert.equal(
    mirror.get("/conversation/new.py")?.toString(),
    "created-in-vm",
    "created file round-trips into the mirror"
  )
  assert.equal(
    mirror.has("/conversation/gone.py"),
    false,
    "deleted file is gone from the mirror (delete propagates to the next base)"
  )
})
