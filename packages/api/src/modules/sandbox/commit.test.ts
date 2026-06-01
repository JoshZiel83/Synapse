import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
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
  getActiveMountsForSession,
  getFileSpace,
  updateFileMount,
} from "./space.js"
import {
  scanCommitDir,
  materializeSnapshot,
  resolveFsHelperPath,
} from "./materialize.js"
import { commitSpaces, type CommitDeps } from "./service.js"

/**
 * Function-level coverage for the commit path's loss-safety branch (round-7 #A /
 * round-8 follow-up): when the post-commit live-dir reconcile FAILS, the mount's
 * base MUST NOT advance — so the next turn's refresh (head != base) re-runs the
 * reconcile and self-heals instead of letting a stale local loser silently
 * overwrite head on the following commit.
 *
 * Uses the gc.test.ts pattern: a real test-DB client (withTestDbAndClient,
 * BEGIN/ROLLBACK) injected via CommitDeps so commitSpaces' reads/writes/txn all
 * run on the one pinned connection and see the seeded rows. The fs-helper binary
 * produces real manifests/CAS so scan_commit yields a genuine conflict.
 */

let helperAvailable = true
try {
  resolveFsHelperPath()
} catch {
  helperAvailable = false
}

const NS = "scommit"
function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function seed(db: Kysely<any>) {
  const user = await db
    .insertInto("users")
    .values({ email: `${rid()}@${NS}`, name: "u", password_hash: "x" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ owner_id: user.id, slug: `ws-${rid()}`, name: `${NS} ws` })
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      workspace_id: ws.id,
      name: `a-${rid()}`,
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
    conversationId: conv.id as string,
    sessionId: session.id as string,
  }
}

async function ingest(
  client: { query: (t: string, p?: any[]) => Promise<any> },
  scan: { manifest_sha256: string; new_blobs: string[] }
) {
  await ensureContentBlob(client, {
    sha256: scan.manifest_sha256,
    sizeBytes: 0,
  })
  for (const blob of scan.new_blobs) {
    await ensureContentBlob(client, { sha256: blob, sizeBytes: 0 })
  }
}

test(
  "commitSpaces: a FAILED post-commit reconcile does NOT advance the mount base (round-7 #A / round-8)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, conversationId, sessionId } = await seed(db)

      // Inject the test client as the commit executor + ctx loader, so the whole
      // commit runs on this pinned connection and sees the seeded rows.
      const depsBase: Partial<CommitDeps> = {
        dbh: client as unknown as CommitDeps["dbh"],
        runInTx: async (fn) => fn(client as unknown as CommitDeps["dbh"]),
        loadCtx: async () => ({
          workspaceId,
          conversationId,
          actorId,
        }),
      }

      const work = mkdtempSync(join(tmpdir(), "synapse-commit-"))

      // base snapshot: x.txt = "A".
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, "x.txt"), "A")
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ingest(client, baseScan)

      const space = await ensureFileSpace(client, {
        workspaceId,
        owner: actorRef(actorId),
      })
      const baseSnap = await appendSnapshot(client, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: null,
        manifestSha256: baseScan.manifest_sha256,
        entryCount: baseScan.entry_count,
        totalBytes: baseScan.total_bytes,
      })

      // head snapshot: x.txt = "B" (a concurrent writer advanced the space head).
      const headDir = join(work, "head")
      mkdirSync(headDir, { recursive: true })
      writeFileSync(join(headDir, "x.txt"), "B")
      const headScan = await scanCommitDir({ dir: headDir })
      await ingest(client, headScan)
      const headSnap = await appendSnapshot(client, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: baseSnap.id,
        manifestSha256: headScan.manifest_sha256,
        entryCount: headScan.entry_count,
        totalBytes: headScan.total_bytes,
      })

      // live dir: materialized base, agent locally edits x.txt = "L" (a conflict
      // vs head "B"). The mount's base is the OLD baseSnap (head moved to B).
      const liveDir = join(work, "actor")
      mkdirSync(liveDir, { recursive: true })
      await materializeSnapshot({
        manifestSha256: baseScan.manifest_sha256,
        targetDir: liveDir,
      })
      writeFileSync(join(liveDir, "x.txt"), "L")

      await insertFileMount(client, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await updateFileMount(client, await mountId(client, sessionId), {
        status: "active",
      })

      // Commit with a reconcile that FAILED MID-WAY but had already written a
      // sidecar (round-9 #2): simulates dir_sync stopping early after preserving
      // the loser. ok=false must leave base unadvanced (round-7 #A) AND the
      // partial sidecar must still be surfaced in the pending conflict.
      let reconcileCalled = false
      const result = await commitSpaces(sessionId, ["actor"], {
        ...depsBase,
        reconcile: async (_m, _b, _c, hadConflicts) => {
          reconcileCalled = true
          assert.equal(hadConflicts, true, "the commit must be a conflict")
          return {
            ok: false,
            sidecars: [
              {
                original: "/actor/x.txt",
                sidecar: "/actor/.synapse-conflicts/deadbeef",
                kind: "file",
              },
            ],
          }
        },
      })

      assert.equal(reconcileCalled, true, "reconcile was invoked")
      // Single-file conflict where merged == latest (equals-latest branch): no
      // new snapshot, but the conflict is reported.
      assert.equal(
        result.snapshotIdBySubpath.actor,
        undefined,
        "equals-latest branch produces no new snapshot"
      )
      assert.ok(
        result.conflictsBySubpath.actor?.includes("/x.txt"),
        "x.txt reported as a commit conflict"
      )

      // THE KEY ASSERTION: base must NOT have advanced (reconcile failed), so the
      // next turn's refresh (head != base) will re-run and self-heal.
      const mounts = await getActiveMountsForSession(client, sessionId)
      const actorMount = mounts.find((m) => m.mount_subpath === "actor")
      assert.ok(actorMount, "actor mount still active")
      assert.equal(
        actorMount!.base_snapshot_id,
        baseSnap.id,
        "base must stay at the OLD base after a failed reconcile (not advanced)"
      )
      assert.notEqual(
        actorMount!.base_snapshot_id,
        headSnap.id,
        "base must NOT be the head/new snapshot"
      )
      // round-9 #2: the partial sidecar written before the failure is surfaced.
      assert.deepEqual(
        result.sidecarsBySubpath.actor,
        [
          {
            original: "/actor/x.txt",
            sidecar: "/actor/.synapse-conflicts/deadbeef",
            kind: "file",
          },
        ],
        "partial sidecar from a failed reconcile must still be surfaced"
      )
    })
  }
)

test(
  "commitSpaces: a SUCCESSFUL conflict commit advances base + records pending conflict",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, conversationId, sessionId } = await seed(db)
      const depsBase: Partial<CommitDeps> = {
        dbh: client as unknown as CommitDeps["dbh"],
        runInTx: async (fn) => fn(client as unknown as CommitDeps["dbh"]),
        loadCtx: async () => ({ workspaceId, conversationId, actorId }),
      }

      const work = mkdtempSync(join(tmpdir(), "synapse-commit2-"))
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, "x.txt"), "A")
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ingest(client, baseScan)
      const space = await ensureFileSpace(client, {
        workspaceId,
        owner: actorRef(actorId),
      })
      const baseSnap = await appendSnapshot(client, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: null,
        manifestSha256: baseScan.manifest_sha256,
        entryCount: baseScan.entry_count,
        totalBytes: baseScan.total_bytes,
      })
      const headDir = join(work, "head")
      mkdirSync(headDir, { recursive: true })
      writeFileSync(join(headDir, "x.txt"), "B")
      const headScan = await scanCommitDir({ dir: headDir })
      await ingest(client, headScan)
      await appendSnapshot(client, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: baseSnap.id,
        manifestSha256: headScan.manifest_sha256,
        entryCount: headScan.entry_count,
        totalBytes: headScan.total_bytes,
      })

      const liveDir = join(work, "actor")
      mkdirSync(liveDir, { recursive: true })
      await materializeSnapshot({
        manifestSha256: baseScan.manifest_sha256,
        targetDir: liveDir,
      })
      writeFileSync(join(liveDir, "x.txt"), "L")
      await insertFileMount(client, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await updateFileMount(client, await mountId(client, sessionId), {
        status: "active",
      })

      // Reconcile SUCCEEDS (stub returns a sidecar without touching disk — the
      // base-advance decision is what we're testing, not the fs mechanism which
      // materialize.test.ts covers).
      const result = await commitSpaces(sessionId, ["actor"], {
        ...depsBase,
        reconcile: async () => ({
          ok: true,
          sidecars: [
            {
              original: "/actor/x.txt",
              sidecar: "/actor/.synapse-conflicts/deadbeef",
              kind: "file",
            },
          ],
        }),
      })

      assert.ok(
        result.conflictsBySubpath.actor?.includes("/x.txt"),
        "x.txt reported as a commit conflict"
      )
      const mounts = await getActiveMountsForSession(client, sessionId)
      const actorMount = mounts.find((m) => m.mount_subpath === "actor")
      // base ADVANCED to the new snapshot (reconcile succeeded → live==committed).
      assert.notEqual(
        actorMount!.base_snapshot_id,
        baseSnap.id,
        "base advanced past the old base on a successful reconcile"
      )
      assert.ok(actorMount!.base_snapshot_id, "base set to the new snapshot")

      // The pending conflict was recorded WITH its sidecar (round-7 #C).
      const stateRow = await client.query(
        `SELECT collaboration_state FROM sessions WHERE id = $1`,
        [sessionId]
      )
      const pending = (stateRow.rows[0]?.collaboration_state ?? {})[
        "_sandboxPendingCommitConflicts"
      ]
      assert.ok(pending?.actor, "pending conflict stashed for /actor")
      assert.deepEqual(pending.actor.paths, ["/x.txt"])
      assert.equal(
        pending.actor.sidecars[0]?.original,
        "/actor/x.txt",
        "sidecar pointer persisted for the agent's next-turn notice"
      )
    })
  }
)

test(
  "commitSpaces: conflict + committable local change → snapshot APPENDED then reconcile fails → base NOT advanced (round-9 #3)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    // The two cases above hit the equals-latest branch (merged == latest, no new
    // snapshot). This drives the OTHER branch: a conflict on x.txt AND a clean
    // local add of y.txt, so the merged manifest != latest → a NEW snapshot is
    // appended FIRST, then reconcile runs. With reconcile failing, the snapshot
    // exists (head advanced) + result_snapshot is recorded, but base must NOT
    // advance (round-7 #A self-heal) — and the partial sidecar is surfaced.
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, conversationId, sessionId } = await seed(db)
      const depsBase: Partial<CommitDeps> = {
        dbh: client as unknown as CommitDeps["dbh"],
        runInTx: async (fn) => fn(client as unknown as CommitDeps["dbh"]),
        loadCtx: async () => ({ workspaceId, conversationId, actorId }),
      }

      const work = mkdtempSync(join(tmpdir(), "synapse-commit3-"))
      // base: x.txt = "A".
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, "x.txt"), "A")
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ingest(client, baseScan)
      const space = await ensureFileSpace(client, {
        workspaceId,
        owner: actorRef(actorId),
      })
      const baseSnap = await appendSnapshot(client, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: null,
        manifestSha256: baseScan.manifest_sha256,
        entryCount: baseScan.entry_count,
        totalBytes: baseScan.total_bytes,
      })
      // head: x.txt = "B" (concurrent writer).
      const headDir = join(work, "head")
      mkdirSync(headDir, { recursive: true })
      writeFileSync(join(headDir, "x.txt"), "B")
      const headScan = await scanCommitDir({ dir: headDir })
      await ingest(client, headScan)
      const headSnap = await appendSnapshot(client, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: baseSnap.id,
        manifestSha256: headScan.manifest_sha256,
        entryCount: headScan.entry_count,
        totalBytes: headScan.total_bytes,
      })
      // live: materialized base; agent edits x.txt = "L" (conflict) AND adds
      // y.txt = "Y" (a clean local change). merged = head x.txt="B" + y.txt="Y",
      // which is NOT equal to latest (head has no y.txt) → append branch.
      const liveDir = join(work, "actor")
      mkdirSync(liveDir, { recursive: true })
      await materializeSnapshot({
        manifestSha256: baseScan.manifest_sha256,
        targetDir: liveDir,
      })
      writeFileSync(join(liveDir, "x.txt"), "L")
      writeFileSync(join(liveDir, "y.txt"), "Y")
      await insertFileMount(client, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await updateFileMount(client, await mountId(client, sessionId), {
        status: "active",
      })

      const result = await commitSpaces(sessionId, ["actor"], {
        ...depsBase,
        reconcile: async (_m, _b, _c, hadConflicts) => {
          assert.equal(hadConflicts, true, "must be a conflict commit")
          return {
            ok: false,
            sidecars: [
              {
                original: "/actor/x.txt",
                sidecar: "/actor/.synapse-conflicts/cafe",
                kind: "file",
              },
            ],
          }
        },
      })

      // A NEW snapshot WAS appended (merged != latest → append branch ran).
      const newSnapId = result.snapshotIdBySubpath.actor
      assert.ok(newSnapId, "a new snapshot was appended (append branch)")
      assert.notEqual(newSnapId, headSnap.id, "it's a fresh snapshot, not head")
      assert.ok(
        result.conflictsBySubpath.actor?.includes("/x.txt"),
        "x.txt reported as a commit conflict"
      )

      const mounts = await getActiveMountsForSession(client, sessionId)
      const actorMount = mounts.find((m) => m.mount_subpath === "actor")!
      // base NOT advanced (reconcile failed) — round-7 #A self-heal …
      assert.equal(
        actorMount.base_snapshot_id,
        baseSnap.id,
        "base must stay at the OLD base after a failed reconcile in the append branch"
      )
      // … but result_snapshot WAS recorded for audit (the snapshot exists).
      assert.equal(
        actorMount.result_snapshot_id,
        newSnapId,
        "result_snapshot records the appended snapshot even when base lags"
      )
      // Space head advanced to the new snapshot (the append committed).
      const headNow = await getFileSpace(client, space.id)
      assert.equal(
        headNow?.current_snapshot_id,
        newSnapId,
        "space head advanced to the appended snapshot"
      )
      // The pending conflict + partial sidecar were recorded (round-9 #2/#3).
      const stateRow = await client.query(
        `SELECT collaboration_state FROM sessions WHERE id = $1`,
        [sessionId]
      )
      const pending = (stateRow.rows[0]?.collaboration_state ?? {})[
        "_sandboxPendingCommitConflicts"
      ]
      assert.deepEqual(pending?.actor?.paths, ["/x.txt"])
      assert.equal(
        pending?.actor?.sidecars?.[0]?.original,
        "/actor/x.txt",
        "partial sidecar recorded for the agent even though reconcile failed"
      )
    })
  }
)

/** Helper: the id of the (single) mount we just inserted for this session. */
async function mountId(
  client: { query: (t: string, p?: any[]) => Promise<any> },
  sessionId: string
): Promise<string> {
  const r = await client.query(
    `SELECT id FROM file_mounts WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [sessionId]
  )
  return r.rows[0].id as string
}
