import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { actorRef } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDbAndClient } from "../../test/helpers/db.js"
import {
  ensureFileSpace,
  insertFileMount,
  appendSnapshot,
  ensureContentBlob,
} from "./space.js"
import {
  scanCommitDir,
  resolveFsHelperPath,
  materializeSnapshot,
} from "./materialize.js"
import { refreshSpaces, type RefreshDeps } from "./service.js"
import {
  mergePendingRefreshConflicts,
  decodePendingRefresh,
} from "./pending-conflicts.js"

let helperAvailable = true
try {
  resolveFsHelperPath()
} catch {
  helperAvailable = false
}

const NS = "srefresh"
function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Refresh conflicts are persisted for at-least-once delivery (round-10 #1): if a
 * turn is interrupted after refresh resolved a conflict (live→head, base
 * advanced, sidecar written) but before the actor consumed the notice, the next
 * turn must STILL surface it (else the sidecar is an orphaned recovery file).
 * These cover the pure merge + normalize used by the durable store.
 */

test("mergePendingRefreshConflicts: unions deferred paths + sidecars across turns", () => {
  const prev = {
    deferredConflictsBySubpath: { conversation: ["/a.txt"] },
    sidecarsBySubpath: {
      conversation: [
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/h1",
          kind: "file",
        },
      ],
    },
  }
  const out = mergePendingRefreshConflicts(prev, {
    deferredConflictsBySubpath: { conversation: ["/b.txt"], actor: ["/c.txt"] },
    sidecarsBySubpath: {
      conversation: [
        {
          original: "/conversation/b.txt",
          sidecar: "/conversation/.synapse-conflicts/h2",
          kind: "file",
        },
      ],
    },
  })
  assert.deepEqual(out.deferredConflictsBySubpath.conversation.sort(), [
    "/a.txt",
    "/b.txt",
  ])
  assert.deepEqual(out.deferredConflictsBySubpath.actor, ["/c.txt"])
  // both sidecars on the same subpath survive (distinct leaves).
  assert.equal(out.sidecarsBySubpath.conversation.length, 2)
})

test("mergePendingRefreshConflicts: same-original distinct sidecars both survive (round-10 #2)", () => {
  const prev = {
    deferredConflictsBySubpath: { actor: ["/x.txt"] },
    sidecarsBySubpath: {
      actor: [
        {
          original: "/actor/x.txt",
          sidecar: "/actor/.synapse-conflicts/h1",
          kind: "file",
        },
      ],
    },
  }
  const out = mergePendingRefreshConflicts(prev, {
    deferredConflictsBySubpath: { actor: ["/x.txt"] },
    sidecarsBySubpath: {
      actor: [
        // re-record same leaf = idempotent
        {
          original: "/actor/x.txt",
          sidecar: "/actor/.synapse-conflicts/h1",
          kind: "file",
        },
        // same original, different content → distinct leaf → kept
        {
          original: "/actor/x.txt",
          sidecar: "/actor/.synapse-conflicts/h2",
          kind: "file",
        },
      ],
    },
  })
  assert.equal(
    out.sidecarsBySubpath.actor.length,
    2,
    "both unconsumed copies kept"
  )
  assert.deepEqual(
    out.deferredConflictsBySubpath.actor,
    ["/x.txt"],
    "path deduped"
  )
})

test("decodePendingRefresh: a well-formed blob (file + symlink sidecars) passes through", () => {
  const raw = {
    deferredConflictsBySubpath: { conversation: ["/a"] },
    sidecarsBySubpath: {
      conversation: [
        {
          original: "/conversation/a",
          sidecar: "/conversation/.synapse-conflicts/h",
          kind: "file",
          contentSha: "a".repeat(64),
        },
        {
          original: "/conversation/b",
          sidecar: "/conversation/.synapse-conflicts/h2",
          kind: "symlink",
          target: "/etc/hosts",
        },
      ],
    },
  }
  const out = decodePendingRefresh(raw)
  assert.equal(out.sidecarsBySubpath.conversation[0].kind, "file")
  assert.equal(out.sidecarsBySubpath.conversation[1].kind, "symlink")
})

test("decodePendingRefresh: a sidecar missing the required `kind` fails SAFE to empty maps (strict, no kind→file default)", () => {
  const out = decodePendingRefresh({
    deferredConflictsBySubpath: {},
    sidecarsBySubpath: {
      conversation: [
        { original: "/conversation/a", sidecar: "/conversation/x" }, // no kind
      ],
    },
  })
  assert.deepEqual(out, {
    deferredConflictsBySubpath: {},
    sidecarsBySubpath: {},
  })
})

test("decodePendingRefresh: null/garbage → empty maps", () => {
  assert.deepEqual(decodePendingRefresh(undefined), {
    deferredConflictsBySubpath: {},
    sidecarsBySubpath: {},
  })
  assert.deepEqual(decodePendingRefresh("nope"), {
    deferredConflictsBySubpath: {},
    sidecarsBySubpath: {},
  })
})

async function seed(db: Kysely<any>) {
  const user = await db
    .insertInto("users")
    .values({ email: `${rid()}@${NS}`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ owner_id: user.id, slug: `ws-${rid()}`, name: `${NS} ws` })
    .returning("id")
    .executeTakeFirstOrThrow()
  // workspace_resources.created_by_subject_id is NOT NULL; mint a workspace-kind creator subject.
  const createdBySubjectId = (
    await db
      .insertInto("access_subjects")
      .values({ kind: "workspace", workspace_id: ws.id } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id as string
  const actorRoot = await db
    .insertInto("workspace_resources")
    .values({
      id: crypto.randomUUID(),
      workspace_id: ws.id,
      kind: "actor",
      display_name: `a-${rid()}`,
      status: "active",
      created_by_subject_id: createdBySubjectId,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: "t",
      current_version: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({ workspace_id: ws.id, kind: "direct", title: "t" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const session = await db
    .insertInto("sessions")
    .values({
      workspace_id: ws.id,
      conversation_id: conv.id,
      actor_id: actor.id,
      status: "running",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return {
    workspaceId: ws.id as string,
    actorId: actor.id as string,
    sessionId: session.id as string,
  }
}

test(
  "refreshSpaces: a conflict is PERSISTED durably for next-turn delivery (round-10 #1)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, sessionId } = await seed(db)

      // Two snapshots so head != base → refresh runs the sync.
      const work = mkdtempSync(join(tmpdir(), "synapse-refresh-"))
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ensureContentBlob(db, {
        sha256: baseScan.manifest_sha256,
        sizeBytes: 0,
        backend: "local_cas",
      })
      const space = await ensureFileSpace(db, {
        workspaceId,
        owner: actorRef(actorId),
      })
      const baseSnap = await appendSnapshot(db, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: null,
        manifestSha256: baseScan.manifest_sha256,
        entryCount: baseScan.entry_count,
        totalBytes: baseScan.total_bytes,
      })
      const headDir = join(work, "head")
      mkdirSync(headDir, { recursive: true })
      const headScan = await scanCommitDir({ dir: headDir })
      await ensureContentBlob(db, {
        sha256: headScan.manifest_sha256,
        sizeBytes: 0,
        backend: "local_cas",
      })
      await appendSnapshot(db, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: baseSnap.id,
        manifestSha256: headScan.manifest_sha256,
        entryCount: headScan.entry_count,
        totalBytes: headScan.total_bytes,
      })

      const liveDir = join(work, "actor")
      mkdirSync(liveDir, { recursive: true })
      await insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await client.query(
        `UPDATE file_mounts SET status = 'active' WHERE session_id = $1`,
        [sessionId]
      )

      // Inject a sync that reports a CONFLICT + sidecar (fully synced, ok).
      const depsOverride: Partial<RefreshDeps> = {
        dbh: db,
        runInTx: async (fn) => fn(db),
        sync: async () => ({
          applied: [],
          deferred_conflicts: ["/x.txt"],
          conflict_sidecars: [
            {
              original: "/x.txt",
              sidecar: "/.synapse-conflicts/h1",
              kind: "file",
            },
          ],
          new_base_manifest_sha256: headScan.manifest_sha256,
        }),
      }

      const result = await refreshSpaces(sessionId, depsOverride)
      assert.deepEqual(result.deferredConflictsBySubpath.actor, ["/x.txt"])

      // THE KEY ASSERTION (round-10 #1): the conflict is DURABLY persisted on the
      // session, so a next turn (after this turn advanced base to head) still
      // re-surfaces it instead of orphaning the sidecar.
      const stateRow = await client.query(
        `SELECT collaboration_state FROM sessions WHERE id = $1`,
        [sessionId]
      )
      const pending = (stateRow.rows[0]?.collaboration_state ?? {})[
        "_sandboxPendingRefreshConflicts"
      ]
      assert.ok(pending, "refresh conflict persisted to collaboration_state")
      const norm = decodePendingRefresh(pending)
      assert.deepEqual(norm.deferredConflictsBySubpath.actor, ["/x.txt"])
      assert.equal(
        norm.sidecarsBySubpath.actor?.[0]?.original,
        "/actor/x.txt",
        "persisted sidecar is mount-prefixed + retained"
      )
      assert.equal(norm.sidecarsBySubpath.actor?.[0]?.kind, "file")
    })
  }
)

test(
  "refreshSpaces: a persist failure leaves base UNADVANCED (round-11 #2 atomicity)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, sessionId } = await seed(db)
      const work = mkdtempSync(join(tmpdir(), "synapse-r11atom-"))
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ensureContentBlob(db, {
        sha256: baseScan.manifest_sha256,
        sizeBytes: 0,
        backend: "local_cas",
      })
      const space = await ensureFileSpace(db, {
        workspaceId,
        owner: actorRef(actorId),
      })
      const baseSnap = await appendSnapshot(db, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: null,
        manifestSha256: baseScan.manifest_sha256,
        entryCount: baseScan.entry_count,
        totalBytes: baseScan.total_bytes,
      })
      const headDir = join(work, "head")
      mkdirSync(headDir, { recursive: true })
      const headScan = await scanCommitDir({ dir: headDir })
      await ensureContentBlob(db, {
        sha256: headScan.manifest_sha256,
        sizeBytes: 0,
        backend: "local_cas",
      })
      await appendSnapshot(db, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: baseSnap.id,
        manifestSha256: headScan.manifest_sha256,
        entryCount: headScan.entry_count,
        totalBytes: headScan.total_bytes,
      })
      const liveDir = join(work, "actor")
      mkdirSync(liveDir, { recursive: true })
      await insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await client.query(
        `UPDATE file_mounts SET status = 'active' WHERE session_id = $1`,
        [sessionId]
      )

      // Inject a sync reporting a conflict, but a runInTx that FAILS — modeling a
      // persist failure. Because persist + base-advance are now ONE transaction
      // (round-11 #2), the failure must leave base UNADVANCED so head!=base
      // self-heals next turn (instead of silently dropping the durable notice).
      const depsOverride: Partial<RefreshDeps> = {
        dbh: db,
        runInTx: async () => {
          throw new Error("simulated persist failure")
        },
        sync: async () => ({
          applied: [],
          deferred_conflicts: ["/x.txt"],
          conflict_sidecars: [
            {
              original: "/x.txt",
              sidecar: "/.synapse-conflicts/h1",
              kind: "file",
              content_sha: "abc",
            },
          ],
          new_base_manifest_sha256: headScan.manifest_sha256,
        }),
      }

      const result = await refreshSpaces(sessionId, depsOverride)
      // The mount is reported as a sync failure (not silently advanced).
      assert.ok(
        result.syncFailuresBySubpath.actor,
        "persist failure surfaced as a sync failure"
      )

      // THE KEY ASSERTION (round-11 #2): base must NOT have advanced — the
      // base-advance was in the same (failed) txn as the persist, so it rolled
      // back. head != base → next turn re-runs the sync.
      const mountRow = await client.query(
        `SELECT base_snapshot_id FROM file_mounts WHERE session_id = $1`,
        [sessionId]
      )
      assert.equal(
        mountRow.rows[0]?.base_snapshot_id,
        baseSnap.id,
        "base must stay at the OLD base when the pending persist failed"
      )
    })
  }
)

test(
  "refreshSpaces: persist failure leaves the live conflict path as the agent's copy (R12-1 deferred apply)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, sessionId } = await seed(db)
      const work = mkdtempSync(join(tmpdir(), "synapse-r12defer-"))

      // base: x.txt = "base"
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, "x.txt"), "base")
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ensureContentBlob(db, {
        sha256: baseScan.manifest_sha256,
        sizeBytes: 0,
        backend: "local_cas",
      })
      for (const b of baseScan.new_blobs)
        await ensureContentBlob(db, {
          sha256: b,
          sizeBytes: 0,
          backend: "local_cas",
        })
      const space = await ensureFileSpace(db, {
        workspaceId,
        owner: actorRef(actorId),
      })
      const baseSnap = await appendSnapshot(db, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: null,
        manifestSha256: baseScan.manifest_sha256,
        entryCount: baseScan.entry_count,
        totalBytes: baseScan.total_bytes,
      })

      // head: x.txt = "head" (concurrent writer)
      const headDir = join(work, "head")
      mkdirSync(headDir, { recursive: true })
      writeFileSync(join(headDir, "x.txt"), "head")
      const headScan = await scanCommitDir({ dir: headDir })
      await ensureContentBlob(db, {
        sha256: headScan.manifest_sha256,
        sizeBytes: 0,
        backend: "local_cas",
      })
      for (const b of headScan.new_blobs)
        await ensureContentBlob(db, {
          sha256: b,
          sizeBytes: 0,
          backend: "local_cas",
        })
      await appendSnapshot(db, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: baseSnap.id,
        manifestSha256: headScan.manifest_sha256,
        entryCount: headScan.entry_count,
        totalBytes: headScan.total_bytes,
      })

      // live: materialize base, then the agent locally edits x.txt = "local".
      const liveDir = join(work, "actor")
      mkdirSync(liveDir, { recursive: true })
      await materializeSnapshot({
        manifestSha256: baseScan.manifest_sha256,
        targetDir: liveDir,
      })
      writeFileSync(join(liveDir, "x.txt"), "local")
      await insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await client.query(
        `UPDATE file_mounts SET status = 'active' WHERE session_id = $1`,
        [sessionId]
      )

      // Real sync (writes the sidecar, DEFERS the head overwrite), but the
      // durable persist (step 1) FAILS. applyHead must never run.
      let applyHeadCalled = false
      const result = await refreshSpaces(sessionId, {
        dbh: db,
        runInTx: async () => {
          throw new Error("simulated persist failure")
        },
        applyHead: async () => {
          applyHeadCalled = true
        },
      })

      assert.ok(
        result.syncFailuresBySubpath.actor,
        "persist failure surfaced as a sync failure"
      )
      assert.equal(
        applyHeadCalled,
        false,
        "head was NOT applied after persist failed"
      )

      // THE KEY ASSERTION (R12-1): the live conflict path still holds the AGENT's
      // copy (not head), so next turn working != head re-derives the conflict —
      // the notice is not silently lost even though it wasn't persisted.
      assert.equal(
        readFileSync(join(liveDir, "x.txt"), "utf8"),
        "local",
        "live conflict path must still be the agent's copy when persist failed"
      )
      // And base did not advance.
      const mountRow = await client.query(
        `SELECT base_snapshot_id FROM file_mounts WHERE session_id = $1`,
        [sessionId]
      )
      assert.equal(mountRow.rows[0]?.base_snapshot_id, baseSnap.id)

      // The sidecar WAS written (recoverable) even though the live path wasn't
      // overwritten — the agent's copy is preserved both in-place and at sidecar.
      assert.ok(
        result.sidecarsBySubpath.actor?.length,
        "sidecar written despite deferred head apply"
      )
    })
  }
)

test("refreshSpaces: OFF-BOX session is a NO-OP — base not advanced, sync never called (R6 #2)", async () => {
  await withTestDbAndClient(async ({ db, client }) => {
    const { workspaceId, actorId, sessionId } = await seed(db)
    const space = await ensureFileSpace(db, {
      workspaceId,
      owner: actorRef(actorId),
    })
    await insertFileMount(db, {
      workspaceId,
      sessionId,
      fileSpaceId: space.id,
      mountSubpath: "actor",
      baseSnapshotId: null,
      materializedDir: "/tmp/offbox-mirror",
    })
    await client.query(
      `UPDATE file_mounts SET status = 'active' WHERE session_id = $1`,
      [sessionId]
    )
    // An OFF-BOX (cubesandbox) sandbox for the session — the gate resolves the
    // adapter and short-circuits refresh.
    const rtId = crypto.randomUUID()
    await db
      .insertInto("runtimes")
      .values({ id: rtId, workspaceId, kind: "sandbox" } as any)
      .execute()
    await client.query(
      `INSERT INTO sandboxes (id, workspace_id, session_id, mode, adapter, state, resource_id, host_pid, platform, arch)
       VALUES ($1, $2, $3, 'bare', 'cubesandbox', 'active', 'vm-off', NULL, 'linux', 'x64')`,
      [rtId, workspaceId, sessionId]
    )

    let syncCalled = false
    const result = await refreshSpaces(sessionId, {
      dbh: db,
      runInTx: async (fn) => fn(db),
      sync: async () => {
        syncCalled = true
        return {
          applied: [],
          deferred_conflicts: [],
          conflict_sidecars: [],
          new_base_manifest_sha256: "",
        }
      },
    })

    // No mirror head-apply / base-advance for off-box — the teardown pull→3-way
    // merge owns reconciliation. sync is never invoked; the result is empty.
    assert.equal(
      syncCalled,
      false,
      "off-box refresh must NOT sync the mirror (else it silently overwrites a concurrent head)"
    )
    assert.deepEqual(result, {
      deferredConflictsBySubpath: {},
      sidecarsBySubpath: {},
      syncFailuresBySubpath: {},
    })
  })
})
