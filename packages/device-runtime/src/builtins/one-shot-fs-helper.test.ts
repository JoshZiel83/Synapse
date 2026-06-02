import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { withOneShotFsHelper } from "./one-shot-fs-helper.js"
import { resolveSidecarPath } from "./fs-helper-resolve.js"

// Locate the built Rust binary via the shared resolver in NEWEST-WINS mode:
// rebuilding one profile (debug) must not be shadowed by a stale build of the
// other (release), and vice versa. process.cwd() is the package dir under
// `npm test -w packages/device-runtime` or the repo root under the root test
// script — probe both.
function findHelperBinary(): string | null {
  return (
    resolveSidecarPath({
      roots: [process.cwd(), join(process.cwd(), "../..")],
      suffixes: [
        "sidecars/fs-helper/target/debug/synapse-device-fs-helper",
        "sidecars/fs-helper/target/release/synapse-device-fs-helper",
      ],
      mode: "newest-wins",
      envVar: "SYNAPSE_DEVICE_FS_HELPER_PATH",
    }) ?? null
  )
}

const HELPER = findHelperBinary()
const SKIP = HELPER === null

test(
  "one-shot helper: cas put/has + manifest scan_commit + materialize roundtrip",
  { skip: SKIP ? "fs-helper binary not built" : false },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "oneshot-"))
    const casDir = join(base, "cas")
    const live = join(base, "live")
    const out = join(base, "out")
    mkdirSync(join(live, "sub"), { recursive: true })
    mkdirSync(join(live, "empty"), { recursive: true })
    writeFileSync(join(live, "a.txt"), "alpha")
    writeFileSync(join(live, "sub/b.txt"), "bravo")

    await withOneShotFsHelper({ helperPath: HELPER!, casDir }, async (h) => {
      // scan_commit the live dir.
      const commit = await h.manifestScanCommit({ dir: live })
      assert.ok(commit.manifest_sha256.length === 64, "manifest sha")
      assert.equal(commit.conflict_paths.length, 0)
      const paths = commit.entries.map((e) => e.path).sort()
      assert.deepEqual(paths, ["/a.txt", "/empty", "/sub", "/sub/b.txt"])
      // has the manifest blob.
      const has = await h.casHas({ sha256: commit.manifest_sha256 })
      assert.equal(has.exists, true)
      // materialize into a fresh dir.
      await h.manifestMaterialize({
        manifest_sha256: commit.manifest_sha256,
        target_dir: out,
      })
      assert.equal(readFileSync(join(out, "a.txt"), "utf8"), "alpha")
      assert.equal(readFileSync(join(out, "sub/b.txt"), "utf8"), "bravo")
      assert.ok(existsSync(join(out, "empty")), "empty dir materialized")
    })
  }
)

test(
  "one-shot helper: same tree → same manifest sha (byte-stable)",
  { skip: SKIP ? "fs-helper binary not built" : false },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "oneshot-"))
    const casDir = join(base, "cas")
    const live = join(base, "live")
    mkdirSync(live, { recursive: true })
    writeFileSync(join(live, "x.txt"), "xx")
    writeFileSync(join(live, "y.txt"), "yy")
    await withOneShotFsHelper({ helperPath: HELPER!, casDir }, async (h) => {
      const a = await h.manifestScanCommit({ dir: live })
      const b = await h.manifestScanCommit({ dir: live })
      assert.equal(a.manifest_sha256, b.manifest_sha256)
    })
  }
)

test(
  "one-shot helper: cas gc deletes orphans, keeps reachable",
  { skip: SKIP ? "fs-helper binary not built" : false },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "oneshot-"))
    const casDir = join(base, "cas")
    const keep = join(base, "keep.txt")
    const orphan = join(base, "orphan.txt")
    writeFileSync(keep, "keep")
    writeFileSync(orphan, "orphan")
    await withOneShotFsHelper({ helperPath: HELPER!, casDir }, async (h) => {
      const k = await h.casPut({ path: keep })
      const o = await h.casPut({ path: orphan })
      // grace_secs:0 disables the young-blob protection so the just-written
      // orphan is collectable in this unit test (the 1h default that guards
      // in-flight commits is covered by the Rust grace-window test).
      const gc = await h.casGc({ reachable_sha256: [k.sha256], grace_secs: 0 })
      assert.equal(gc.deleted_count, 1)
      assert.equal((await h.casHas({ sha256: k.sha256 })).exists, true)
      assert.equal((await h.casHas({ sha256: o.sha256 })).exists, false)
    })
  }
)
