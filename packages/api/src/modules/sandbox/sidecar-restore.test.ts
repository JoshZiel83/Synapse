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
import { scanCommitDir, resolveFsHelperPath } from "./materialize.js"
import {
  restorePendingSidecarsImpl,
  type PendingCommitConflict,
  type PendingRefreshConflicts,
} from "./service.js"

/**
 * round-11 #1: conflict sidecars are files in the live dir, but teardown deletes
 * the live dir while the pending notice (DB) survives. The sidecar content is
 * now CAS-durable (file: content_sha; symlink: target), and provisionSandbox
 * re-materializes pending sidecars into the FRESH live dir so the agent-visible
 * path resolves again after teardown/re-provision. This drives that restore.
 */

let helperAvailable = true
try {
  resolveFsHelperPath()
} catch {
  helperAvailable = false
}

test(
  "restorePendingSidecars: rebuilds a pending commit-conflict sidecar into a fresh live dir (survives teardown)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-r11restore-"))

    // Ingest a file's bytes into CAS via a scan (simulating the commit scan that
    // preserved the agent's pre-conflict copy). new_blobs[0] is its content sha.
    const seedDir = join(work, "seed")
    mkdirSync(seedDir, { recursive: true })
    writeFileSync(join(seedDir, "x.txt"), "agent-pre-conflict-bytes")
    const scan = await scanCommitDir({ dir: seedDir })
    // Use the manifest entry's sha (dedup-independent: new_blobs is empty on a
    // warm CAS where these exact bytes were already ingested by another test).
    const fileEntry = scan.entries.find((e) => e.path === "/x.txt")
    const contentSha = fileEntry?.sha256 ?? undefined
    assert.ok(contentSha, "file content ingested into CAS")

    // A FRESH live dir (the prior one was deleted by teardown). No sidecar here.
    const liveActor = join(work, "fresh", "actor")
    mkdirSync(liveActor, { recursive: true })

    // A pending COMMIT conflict referencing the CAS-durable sidecar. The sidecar
    // leaf path is mount-prefixed (/actor/.synapse-conflicts/<hash>) as the
    // service records it.
    const sidecarLeaf = "/actor/.synapse-conflicts/h1"
    const pendingCommit: Record<string, PendingCommitConflict> = {
      actor: {
        paths: ["/x.txt"],
        sidecars: [
          {
            original: "/actor/x.txt",
            sidecar: sidecarLeaf,
            kind: "file",
            contentSha,
          },
        ],
      },
    }
    const emptyRefresh: Pick<
      PendingRefreshConflicts,
      "deferredConflictsBySubpath" | "sidecarsBySubpath"
    > = { deferredConflictsBySubpath: {}, sidecarsBySubpath: {} }

    await restorePendingSidecarsImpl(
      "sess-irrelevant",
      [{ mount_subpath: "actor", materialized_dir: liveActor }],
      {
        peekCommit: async () => pendingCommit,
        peekRefresh: async () => emptyRefresh,
      }
    )

    // THE KEY ASSERTION (round-11 #1): the sidecar the pending notice points at
    // now EXISTS again in the fresh live dir, with the preserved bytes.
    const restored = join(liveActor, ".synapse-conflicts", "h1")
    assert.ok(
      existsSync(restored),
      "pending commit sidecar re-materialized after teardown"
    )
    assert.equal(
      readFileSync(restored, "utf8"),
      "agent-pre-conflict-bytes",
      "restored sidecar holds the preserved bytes from CAS"
    )
  }
)

test(
  "restorePendingSidecars: rebuilds a pending refresh symlink sidecar as readable JSON",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-r11restore2-"))
    const liveConv = join(work, "fresh", "conversation")
    mkdirSync(liveConv, { recursive: true })

    const refresh: Pick<
      PendingRefreshConflicts,
      "deferredConflictsBySubpath" | "sidecarsBySubpath"
    > = {
      deferredConflictsBySubpath: { conversation: ["/link"] },
      sidecarsBySubpath: {
        conversation: [
          {
            original: "/conversation/link",
            sidecar: "/conversation/.synapse-conflicts/lh",
            kind: "symlink",
            target: "../elsewhere",
          },
        ],
      },
    }

    await restorePendingSidecarsImpl(
      "sess-irrelevant",
      [{ mount_subpath: "conversation", materialized_dir: liveConv }],
      {
        peekCommit: async () => ({}),
        peekRefresh: async () => refresh,
      }
    )

    const restored = join(liveConv, ".synapse-conflicts", "lh")
    assert.ok(existsSync(restored), "refresh symlink sidecar re-materialized")
    const body = readFileSync(restored, "utf8")
    assert.ok(
      body.includes('"kind":"symlink"') &&
        body.includes('"target":"../elsewhere"'),
      `restored symlink sidecar JSON: ${body}`
    )
  }
)

test(
  "restorePendingSidecars: a sidecar that cannot be restored returns ok=false (R12-3 fail-closed)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-r12-3-"))
    const liveActor = join(work, "fresh", "actor")
    mkdirSync(liveActor, { recursive: true })

    // A pending file sidecar with NO contentSha (e.g. a pre-round-11 record, or a
    // record whose blob is gone) cannot be re-materialized.
    const pendingCommit: Record<string, PendingCommitConflict> = {
      actor: {
        paths: ["/x.txt"],
        sidecars: [
          {
            original: "/actor/x.txt",
            sidecar: "/actor/.synapse-conflicts/h1",
            kind: "file",
            // contentSha intentionally omitted
          },
        ],
      },
    }
    const emptyRefresh: Pick<
      PendingRefreshConflicts,
      "deferredConflictsBySubpath" | "sidecarsBySubpath"
    > = { deferredConflictsBySubpath: {}, sidecarsBySubpath: {} }

    const result = await restorePendingSidecarsImpl(
      "sess-irrelevant",
      [{ mount_subpath: "actor", materialized_dir: liveActor }],
      {
        peekCommit: async () => pendingCommit,
        peekRefresh: async () => emptyRefresh,
      }
    )

    // R12-3: the unrestorable sidecar is reported as failed → ok=false, so the
    // worker keeps the pending record (does NOT clear it after actorThink).
    assert.equal(result.ok, false, "restore reports failure")
    assert.deepEqual(result.failedSidecars, ["/actor/.synapse-conflicts/h1"])
  }
)
