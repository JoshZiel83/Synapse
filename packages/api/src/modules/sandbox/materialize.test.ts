import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resolveFsHelperPath,
  materializeSnapshot,
  scanCommitDir,
  syncDir,
} from "./materialize.js"

/**
 * Supervisor-side materialize/commit/sync round-trip against the REAL Rust
 * fs-helper binary + a throwaway CAS dir. Verifies the API can drive the shared
 * CAS without a live device-runtime. Skips cleanly if the helper binary isn't
 * built (CI without Rust).
 *
 * The CAS dir is overridden via CONTENT_STORE_DIR before importing materialize
 * — but materialize reads CONTENT_STORE_DIR at call time through casDir(), which
 * captured the env at module load. To keep this hermetic we instead point the
 * env BEFORE the storage module loads; since test order isn't guaranteed, we
 * assert against whatever CONTENT_STORE_DIR resolved to and just exercise the
 * round-trip (the CAS location is an internal detail).
 */

let helperAvailable = true
try {
  resolveFsHelperPath()
} catch {
  helperAvailable = false
}

test(
  "materialize.ts: materialize → write → scan_commit → re-materialize round-trip",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-mat-"))
    const live = join(work, "live")
    mkdirSync(live, { recursive: true })

    // 1. Materialize an empty tree into the live dir.
    await materializeSnapshot({ targetDir: live })

    // 2. Write some files (a nested path + an empty dir).
    writeFileSync(join(live, "hello.txt"), "hello world")
    mkdirSync(join(live, "sub"), { recursive: true })
    writeFileSync(join(live, "sub", "nested.txt"), "nested content")
    mkdirSync(join(live, "emptydir"), { recursive: true })

    // 3. Scan-commit the live dir into a manifest + CAS blobs.
    const commit = await scanCommitDir({ dir: live })
    assert.ok(commit.manifest_sha256, "got a manifest sha")
    assert.ok(commit.entry_count >= 3, `entry_count ${commit.entry_count} >= 3`)
    // new_blobs counts only blobs NOT already in the shared CAS; on a warm CAS
    // (these exact bytes committed by a prior run) it can be 0. Correctness is
    // proven by the re-materialize byte-check below, not the new-blob count.
    assert.ok(Array.isArray(commit.new_blobs), "new_blobs present")
    assert.equal(
      commit.conflict_paths.length,
      0,
      "no conflicts on first commit"
    )

    // 4. Re-materialize the committed manifest into a fresh dir → byte-identical.
    const restored = join(work, "restored")
    mkdirSync(restored, { recursive: true })
    await materializeSnapshot({
      manifestSha256: commit.manifest_sha256,
      targetDir: restored,
    })
    assert.equal(
      readFileSync(join(restored, "hello.txt"), "utf8"),
      "hello world"
    )
    assert.equal(
      readFileSync(join(restored, "sub", "nested.txt"), "utf8"),
      "nested content"
    )
    assert.ok(existsSync(join(restored, "emptydir")), "empty dir preserved")

    // 5. Deterministic manifest: committing the restored (identical) tree
    // yields the SAME manifest sha (the v0→v1 invariant).
    const commit2 = await scanCommitDir({ dir: restored })
    assert.equal(
      commit2.manifest_sha256,
      commit.manifest_sha256,
      "same tree → same manifest sha"
    )
  }
)

test(
  "materialize.ts: dir.sync 3-way merges a disjoint incoming change",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-sync-"))

    // Base tree: a.txt only.
    const base = join(work, "base")
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, "a.txt"), "A")
    const baseCommit = await scanCommitDir({ dir: base })

    // Incoming head: base + b.txt (someone else's commit).
    const inc = join(work, "incoming")
    mkdirSync(inc, { recursive: true })
    await materializeSnapshot({
      manifestSha256: baseCommit.manifest_sha256,
      targetDir: inc,
    })
    writeFileSync(join(inc, "b.txt"), "B")
    const incCommit = await scanCommitDir({
      dir: inc,
      baseManifestSha256: baseCommit.manifest_sha256,
    })

    // Live dir: materialized from base, agent locally added c.txt (disjoint).
    const liveDir = join(work, "live")
    mkdirSync(liveDir, { recursive: true })
    await materializeSnapshot({
      manifestSha256: baseCommit.manifest_sha256,
      targetDir: liveDir,
    })
    writeFileSync(join(liveDir, "c.txt"), "C")

    // Sync incoming head into the live dir: b.txt (incoming−base) applies,
    // c.txt (local) is preserved, no conflicts.
    const sync = await syncDir({
      dir: liveDir,
      baseManifestSha256: baseCommit.manifest_sha256,
      toManifestSha256: incCommit.manifest_sha256,
    })
    assert.equal(sync.deferred_conflicts.length, 0, "disjoint → no conflicts")
    assert.ok(existsSync(join(liveDir, "b.txt")), "incoming b.txt applied")
    assert.equal(readFileSync(join(liveDir, "b.txt"), "utf8"), "B")
    assert.ok(existsSync(join(liveDir, "c.txt")), "local c.txt preserved")
    assert.equal(
      sync.new_base_manifest_sha256,
      incCommit.manifest_sha256,
      "base advanced to incoming head"
    )
  }
)

test(
  "materialize.ts: post-commit reconcile brings live to committed manifest + sidecars the loser",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    // This is exactly what commitOneMount.reconcileLiveDir does after a
    // CONFLICTING turn-end commit (round-7 #A, hardened round-8 #1): scan_commit
    // produced a merged manifest that kept HEAD on the conflicting path, but the
    // live dir still holds the agent's loser L. reconcile = syncDir(from=base,
    // to=committedManifest) must (a) overwrite the live path with head's bytes
    // and (b) preserve L at a sidecar — so live == committed and advancing base
    // is safe (no next-turn silent overwrite).
    const work = mkdtempSync(join(tmpdir(), "synapse-reconcile-"))

    // base: x.txt = "A".
    const base = join(work, "base")
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, "x.txt"), "A")
    const baseCommit = await scanCommitDir({ dir: base })

    // head: x.txt = "B" (a concurrent writer's commit).
    const head = join(work, "head")
    mkdirSync(head, { recursive: true })
    writeFileSync(join(head, "x.txt"), "B")
    const headCommit = await scanCommitDir({ dir: head })

    // live: materialized base, agent locally edits x.txt = "L" (conflict).
    const live = join(work, "live")
    mkdirSync(live, { recursive: true })
    await materializeSnapshot({
      manifestSha256: baseCommit.manifest_sha256,
      targetDir: live,
    })
    writeFileSync(join(live, "x.txt"), "L")

    // scan_commit with base + latest=head → conflict, merged keeps head ("B").
    const committed = await scanCommitDir({
      dir: live,
      baseManifestSha256: baseCommit.manifest_sha256,
      latestManifestSha256: headCommit.manifest_sha256,
    })
    assert.deepEqual(
      committed.conflict_paths,
      ["/x.txt"],
      "x.txt is a commit conflict"
    )
    // CRITICAL: at this point the live dir STILL holds "L" — scan_commit doesn't
    // touch it. Without reconcile, advancing base here would silently lose B.
    assert.equal(readFileSync(join(live, "x.txt"), "utf8"), "L")

    // reconcile: syncDir(from=base, to=committedManifest).
    const reconcile = await syncDir({
      dir: live,
      baseManifestSha256: baseCommit.manifest_sha256,
      toManifestSha256: committed.manifest_sha256,
    })

    // live now holds head's "B" (so base==committed is safe to advance)…
    assert.equal(
      readFileSync(join(live, "x.txt"), "utf8"),
      "B",
      "live reconciled to committed (head) value"
    )
    // …and the agent's loser "L" is preserved at the sidecar (not lost).
    const sidecar = join(live, ".synapse-conflicts", "x.txt")
    assert.ok(existsSync(sidecar), "loser preserved at sidecar")
    assert.equal(readFileSync(sidecar, "utf8"), "L")
    assert.ok(
      reconcile.conflict_sidecars.some((c) => c.original === "/x.txt"),
      "reconcile reports the sidecar so the caller can tell the agent"
    )

    // Proof the reconcile closed the silent-overwrite window: a fresh
    // scan_commit of the live dir against base=committed now sees NO conflict
    // (live == committed), so the next turn won't re-derive or overwrite.
    const after = await scanCommitDir({
      dir: live,
      baseManifestSha256: committed.manifest_sha256,
      latestManifestSha256: committed.manifest_sha256,
    })
    assert.equal(
      after.conflict_paths.length,
      0,
      "after reconcile, live==committed → no residual conflict"
    )
    assert.equal(
      after.manifest_sha256,
      committed.manifest_sha256,
      "live now equals the committed manifest exactly"
    )
  }
)
