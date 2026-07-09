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
  planReplication,
  reconcileStatCache,
  parseFindListing,
  stashUncommittedWorkingSet,
  type DockerExecFn,
  type StatCache,
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
    containerId: "cid",
    mirrorDir: "/tmp/mirror",
    mountRoots: ["/conversation"],
    exec,
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
    containerId: "cid",
    mirrorDir: "/tmp/mirror",
    mountRoots: ["/conversation"],
    exec,
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
    containerId: "cid",
    mirrorDir: "/tmp/mirror",
    mountRoots: ["/conversation"],
    exec,
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
    containerId: "cid",
    mirrorDir: "/tmp/mirror",
    mountRoots: ["/conversation"],
    exec,
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
