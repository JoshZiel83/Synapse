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
      [{ mountSubpath: "actor", materializedDir: liveActor }],
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
      [{ mountSubpath: "conversation", materializedDir: liveConv }],
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
      [{ mountSubpath: "actor", materializedDir: liveActor }],
      {
        peekCommit: async () => pendingCommit,
        peekRefresh: async () => emptyRefresh,
      }
    )

    // R12-3: the unrestorable sidecar is reported as failed → ok=false, so the
    // worker keeps the pending record (does NOT clear it after actorThink). P3:
    // a missing-contentSha record can NEVER restore → reason "permanent".
    assert.equal(result.ok, false, "restore reports failure")
    assert.deepEqual(result.failedSidecars, [
      { sidecar: "/actor/.synapse-conflicts/h1", reason: "permanent" },
    ])
  }
)

test(
  "restorePendingSidecars: a sidecar whose subpath has no live mount this provision is TRANSIENT (P2/P3 retryable)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-transient-"))
    const liveActor = join(work, "fresh", "actor")
    mkdirSync(liveActor, { recursive: true })

    // The pending sidecar lives under /conversation, but only /actor is mounted
    // this provision. The payload (contentSha) is present, so a LATER provision
    // with /conversation active can restore it → reason must be "transient".
    const pendingCommit: Record<string, PendingCommitConflict> = {
      conversation: {
        paths: ["/y.txt"],
        sidecars: [
          {
            original: "/conversation/y.txt",
            sidecar: "/conversation/.synapse-conflicts/cv1",
            kind: "file",
            contentSha: "a".repeat(64),
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
      [{ mountSubpath: "actor", materializedDir: liveActor }],
      {
        peekCommit: async () => pendingCommit,
        peekRefresh: async () => emptyRefresh,
      }
    )

    assert.equal(result.ok, false, "restore reports failure")
    assert.deepEqual(result.failedSidecars, [
      { sidecar: "/conversation/.synapse-conflicts/cv1", reason: "transient" },
    ])
  }
)

test(
  "restorePendingSidecars: a symlink sidecar missing its target is PERMANENT",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-perm-symlink-"))
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
            // target intentionally omitted → unrecoverable
          },
        ],
      },
    }

    const result = await restorePendingSidecarsImpl(
      "sess-irrelevant",
      [{ mountSubpath: "conversation", materializedDir: liveConv }],
      {
        peekCommit: async () => ({}),
        peekRefresh: async () => refresh,
      }
    )

    assert.equal(result.ok, false)
    assert.deepEqual(result.failedSidecars, [
      { sidecar: "/conversation/.synapse-conflicts/lh", reason: "permanent" },
    ])
  }
)

test(
  "restorePendingSidecars: a sidecar with an unknown/corrupt kind is PERMANENT (fs-helper rejects it)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-perm-kind-"))
    const liveActor = join(work, "fresh", "actor")
    mkdirSync(liveActor, { recursive: true })

    // A record with kind="dir" (or any non-file/non-symlink value) is corrupt —
    // fs-helper's restore only handles file/symlink, so this can never be
    // rebuilt. It must be PERMANENT, NOT transient (no "will be retried").
    const pendingCommit: Record<string, PendingCommitConflict> = {
      actor: {
        paths: ["/d"],
        sidecars: [
          {
            original: "/actor/d",
            sidecar: "/actor/.synapse-conflicts/dk",
            kind: "dir",
            contentSha: "a".repeat(64),
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
      [{ mountSubpath: "actor", materializedDir: liveActor }],
      {
        peekCommit: async () => pendingCommit,
        peekRefresh: async () => emptyRefresh,
      }
    )

    assert.equal(result.ok, false)
    assert.deepEqual(result.failedSidecars, [
      { sidecar: "/actor/.synapse-conflicts/dk", reason: "permanent" },
    ])
  }
)

test(
  "restorePendingSidecars: a shape-corrupt ref is PERMANENT even when its subpath has NO live mount (mount-independent)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-perm-nomount-"))
    const liveActor = join(work, "fresh", "actor")
    mkdirSync(liveActor, { recursive: true })

    // The corrupt ref lives under /conversation, which is NOT mounted this
    // provision. Shape-irrecoverability is mount-independent, so it must be
    // PERMANENT — not transient just because the mount is inactive.
    const pendingCommit: Record<string, PendingCommitConflict> = {
      conversation: {
        paths: ["/x.txt"],
        sidecars: [
          {
            original: "/conversation/x.txt",
            sidecar: "/conversation/.synapse-conflicts/cx",
            kind: "file",
            // no contentSha → shape-corrupt
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
      [{ mountSubpath: "actor", materializedDir: liveActor }],
      {
        peekCommit: async () => pendingCommit,
        peekRefresh: async () => emptyRefresh,
      }
    )

    assert.equal(result.ok, false)
    assert.deepEqual(result.failedSidecars, [
      { sidecar: "/conversation/.synapse-conflicts/cx", reason: "permanent" },
    ])
  }
)

test(
  "restorePendingSidecars: a sidecar with an UNROUTABLE path is PERMANENT even with a valid payload",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-perm-path-"))
    const liveActor = join(work, "fresh", "actor")
    mkdirSync(liveActor, { recursive: true })

    // The record has a complete file payload (kind+contentSha) but a corrupt
    // sidecar PATH that can't route to any mount (no leading slash). It can never
    // resolve to a live dir → PERMANENT, not transient.
    const pendingCommit: Record<string, PendingCommitConflict> = {
      actor: {
        paths: ["/x.txt"],
        sidecars: [
          {
            original: "/actor/x.txt",
            sidecar: "actor/.synapse-conflicts/bad", // no leading slash → unroutable
            kind: "file",
            contentSha: "a".repeat(64),
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
      [{ mountSubpath: "actor", materializedDir: liveActor }],
      {
        peekCommit: async () => pendingCommit,
        peekRefresh: async () => emptyRefresh,
      }
    )

    assert.equal(result.ok, false)
    assert.deepEqual(result.failedSidecars, [
      { sidecar: "actor/.synapse-conflicts/bad", reason: "permanent" },
    ])
  }
)

test(
  "restorePendingSidecars: a NON-sidecar live path (/actor/x.txt) is PERMANENT and is NOT overwritten (P1 silent-overwrite guard)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    // THE dangerous case: a corrupt pending record whose `sidecar` points at a
    // REAL tree path (/actor/x.txt) instead of /actor/.synapse-conflicts/<leaf>,
    // but with a complete, valid file payload. A loose route regex would treat it
    // as restorable and write the agent's preserved bytes straight onto the live
    // head file — a silent data overwrite. It MUST be classified permanent and
    // the live file MUST be left untouched.
    const work = mkdtempSync(join(tmpdir(), "synapse-overwrite-guard-"))

    // Ingest the agent's preserved bytes into CAS so contentSha is a REAL blob
    // (so the only thing stopping the overwrite is the path guard, not a missing
    // payload).
    const seedDir = join(work, "seed")
    mkdirSync(seedDir, { recursive: true })
    writeFileSync(join(seedDir, "x.txt"), "agent-preserved")
    const scan = await scanCommitDir({ dir: seedDir })
    const contentSha = scan.entries.find((e) => e.path === "/x.txt")?.sha256
    assert.ok(contentSha, "agent bytes ingested into CAS")

    // Live mount currently holds the head version at /actor/x.txt.
    const liveActor = join(work, "fresh", "actor")
    mkdirSync(liveActor, { recursive: true })
    const liveFile = join(liveActor, "x.txt")
    writeFileSync(liveFile, "head-current")

    const pendingCommit: Record<string, PendingCommitConflict> = {
      actor: {
        paths: ["/x.txt"],
        sidecars: [
          {
            original: "/actor/x.txt",
            sidecar: "/actor/x.txt", // NOT under .synapse-conflicts → must be rejected
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

    const result = await restorePendingSidecarsImpl(
      "sess-irrelevant",
      [{ mountSubpath: "actor", materializedDir: liveActor }],
      {
        peekCommit: async () => pendingCommit,
        peekRefresh: async () => emptyRefresh,
      }
    )

    assert.equal(result.ok, false, "restore reports failure")
    assert.deepEqual(
      result.failedSidecars,
      [{ sidecar: "/actor/x.txt", reason: "permanent" }],
      "a non-.synapse-conflicts path is permanent, never restored"
    )
    // THE KEY ASSERTION: the live head file was NOT overwritten.
    assert.equal(
      readFileSync(liveFile, "utf8"),
      "head-current",
      "live tree file must NOT be clobbered by a corrupt sidecar record"
    )
  }
)

test(
  "restorePendingSidecars: a sidecar path with a '..' leaf segment is PERMANENT (no traversal)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    const work = mkdtempSync(join(tmpdir(), "synapse-traversal-guard-"))
    const liveActor = join(work, "fresh", "actor")
    mkdirSync(liveActor, { recursive: true })

    const pendingCommit: Record<string, PendingCommitConflict> = {
      actor: {
        paths: ["/x.txt"],
        sidecars: [
          {
            original: "/actor/x.txt",
            // nested leaf with traversal — not a flat in-namespace leaf
            sidecar: "/actor/.synapse-conflicts/../x.txt",
            kind: "file",
            contentSha: "a".repeat(64),
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
      [{ mountSubpath: "actor", materializedDir: liveActor }],
      {
        peekCommit: async () => pendingCommit,
        peekRefresh: async () => emptyRefresh,
      }
    )

    assert.equal(result.ok, false)
    assert.deepEqual(result.failedSidecars, [
      { sidecar: "/actor/.synapse-conflicts/../x.txt", reason: "permanent" },
    ])
  }
)
