import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { actorRef } from "@synapse/shared"
import type { Kysely } from "kysely"
import { type Executor } from "../../infrastructure/database/kysely.js"
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
    conversationId: conv.id as string,
    sessionId: session.id as string,
  }
}

async function ingest(
  executor: Executor,
  scan: { manifest_sha256: string; new_blobs: string[] }
) {
  await ensureContentBlob(executor, {
    sha256: scan.manifest_sha256,
    sizeBytes: 0,
    backend: "local_cas",
  })
  for (const blob of scan.new_blobs) {
    await ensureContentBlob(executor, {
      sha256: blob,
      sizeBytes: 0,
      backend: "local_cas",
    })
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
        dbh: db,
        runInTx: async (fn) => fn(db),
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
      await ingest(db, baseScan)

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

      // head snapshot: x.txt = "B" (a concurrent writer advanced the space head).
      const headDir = join(work, "head")
      mkdirSync(headDir, { recursive: true })
      writeFileSync(join(headDir, "x.txt"), "B")
      const headScan = await scanCommitDir({ dir: headDir })
      await ingest(db, headScan)
      const headSnap = await appendSnapshot(db, {
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

      await insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await updateFileMount(db, await mountId(client, sessionId), {
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
            deferredConflicts: [],
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
      const mounts = await getActiveMountsForSession(db, sessionId)
      const actorMount = mounts.find((m) => m.mountSubpath === "actor")
      assert.ok(actorMount, "actor mount still active")
      assert.equal(
        actorMount!.baseSnapshotId,
        baseSnap.id,
        "base must stay at the OLD base after a failed reconcile (not advanced)"
      )
      assert.notEqual(
        actorMount!.baseSnapshotId,
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
        dbh: db,
        runInTx: async (fn) => fn(db),
        loadCtx: async () => ({ workspaceId, conversationId, actorId }),
      }

      const work = mkdtempSync(join(tmpdir(), "synapse-commit2-"))
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, "x.txt"), "A")
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ingest(db, baseScan)
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
      writeFileSync(join(headDir, "x.txt"), "B")
      const headScan = await scanCommitDir({ dir: headDir })
      await ingest(db, headScan)
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
      await materializeSnapshot({
        manifestSha256: baseScan.manifest_sha256,
        targetDir: liveDir,
      })
      writeFileSync(join(liveDir, "x.txt"), "L")
      await insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await updateFileMount(db, await mountId(client, sessionId), {
        status: "active",
      })

      // Reconcile SUCCEEDS (stub returns a sidecar without touching disk — the
      // base-advance decision is what we're testing, not the fs mechanism which
      // materialize.test.ts covers).
      const result = await commitSpaces(sessionId, ["actor"], {
        ...depsBase,
        reconcile: async () => ({
          ok: true,
          deferredConflicts: [],
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
      const mounts = await getActiveMountsForSession(db, sessionId)
      const actorMount = mounts.find((m) => m.mountSubpath === "actor")
      // base ADVANCED to the new snapshot (reconcile succeeded → live==committed).
      assert.notEqual(
        actorMount!.baseSnapshotId,
        baseSnap.id,
        "base advanced past the old base on a successful reconcile"
      )
      assert.ok(actorMount!.baseSnapshotId, "base set to the new snapshot")

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
        dbh: db,
        runInTx: async (fn) => fn(db),
        loadCtx: async () => ({ workspaceId, conversationId, actorId }),
      }

      const work = mkdtempSync(join(tmpdir(), "synapse-commit3-"))
      // base: x.txt = "A".
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, "x.txt"), "A")
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ingest(db, baseScan)
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
      // head: x.txt = "B" (concurrent writer).
      const headDir = join(work, "head")
      mkdirSync(headDir, { recursive: true })
      writeFileSync(join(headDir, "x.txt"), "B")
      const headScan = await scanCommitDir({ dir: headDir })
      await ingest(db, headScan)
      const headSnap = await appendSnapshot(db, {
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
      await insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await updateFileMount(db, await mountId(client, sessionId), {
        status: "active",
      })

      const result = await commitSpaces(sessionId, ["actor"], {
        ...depsBase,
        reconcile: async (_m, _b, _c, hadConflicts) => {
          assert.equal(hadConflicts, true, "must be a conflict commit")
          return {
            ok: false,
            deferredConflicts: [],
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

      const mounts = await getActiveMountsForSession(db, sessionId)
      const actorMount = mounts.find((m) => m.mountSubpath === "actor")!
      // base NOT advanced (reconcile failed) — round-7 #A self-heal …
      assert.equal(
        actorMount.baseSnapshotId,
        baseSnap.id,
        "base must stay at the OLD base after a failed reconcile in the append branch"
      )
      // … but result_snapshot WAS recorded for audit (the snapshot exists).
      assert.equal(
        actorMount.resultSnapshotId,
        newSnapId,
        "result_snapshot records the appended snapshot even when base lags"
      )
      // Space head advanced to the new snapshot (the append committed).
      const headNow = await getFileSpace(db, space.id)
      assert.equal(
        headNow?.currentSnapshotId,
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

test(
  "commitSpaces: a commit-conflict pending PERSIST failure rejects (R12-2 — teardown must preserve the live dir)",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, conversationId, sessionId } = await seed(db)

      // runInTx succeeds for the snapshot-append txn but THROWS on the pending
      // conflict record (the 2nd runInTx call). This models the durable persist
      // failing after the snapshot committed + base advanced.
      let txCount = 0
      const depsBase: Partial<CommitDeps> = {
        dbh: db,
        runInTx: async (fn) => {
          txCount += 1
          if (txCount >= 2) throw new Error("simulated pending-persist failure")
          return fn(db)
        },
        loadCtx: async () => ({ workspaceId, conversationId, actorId }),
      }

      const work = mkdtempSync(join(tmpdir(), "synapse-r12-2-"))
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, "x.txt"), "A")
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ingest(db, baseScan)
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
      writeFileSync(join(headDir, "x.txt"), "B")
      const headScan = await scanCommitDir({ dir: headDir })
      await ingest(db, headScan)
      await appendSnapshot(db, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: baseSnap.id,
        manifestSha256: headScan.manifest_sha256,
        entryCount: headScan.entry_count,
        totalBytes: headScan.total_bytes,
      })
      // live: base + a clean local add y.txt (so merged != latest → snapshot
      // append branch runs the FIRST runInTx) AND x.txt conflict (→ pending).
      const liveDir = join(work, "actor")
      mkdirSync(liveDir, { recursive: true })
      await materializeSnapshot({
        manifestSha256: baseScan.manifest_sha256,
        targetDir: liveDir,
      })
      writeFileSync(join(liveDir, "x.txt"), "L")
      writeFileSync(join(liveDir, "y.txt"), "Y")
      await insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await updateFileMount(db, await mountId(client, sessionId), {
        status: "active",
      })

      // R12-2: the persist failure MUST propagate (reject) — so teardown sees
      // commitOk=false and preserves the live dir instead of deleting it.
      await assert.rejects(
        commitSpaces(sessionId, ["actor"], {
          ...depsBase,
          reconcile: async () => ({
            ok: true,
            sidecars: [],
            deferredConflicts: [],
          }),
        }),
        /pending-persist failure/,
        "commitSpaces must reject when the pending-conflict persist fails"
      )
    })
  }
)

test(
  "commitSpaces: P1 durable-before-destructive — a real conflict persists the pending record BEFORE overwriting the live loser + advancing base",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    // Drives the DEFAULT reconcile/applyHead (real fs-helper, deferred apply): the
    // commit conflict's loser must be persisted to collaboration_state BEFORE the
    // live path is overwritten with head and base advances. We force the persist
    // (recordPendingCommitConflicts' runInTx) to fail and assert the live loser is
    // STILL on disk + base unadvanced — proving the persist precedes the
    // destructive head-apply (so a persist failure self-heals next turn).
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, conversationId, sessionId } = await seed(db)

      const work = mkdtempSync(join(tmpdir(), "synapse-p1-defer-"))
      // base x.txt=A
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, "x.txt"), "A")
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ingest(db, baseScan)
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
      // head x.txt=B (concurrent writer) → equals-latest branch (merged==latest).
      const headDir = join(work, "head")
      mkdirSync(headDir, { recursive: true })
      writeFileSync(join(headDir, "x.txt"), "B")
      const headScan = await scanCommitDir({ dir: headDir })
      await ingest(db, headScan)
      await appendSnapshot(db, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: baseSnap.id,
        manifestSha256: headScan.manifest_sha256,
        entryCount: headScan.entry_count,
        totalBytes: headScan.total_bytes,
      })
      // live: materialize base, agent edits x.txt=L (conflict vs head B).
      const liveDir = join(work, "actor")
      mkdirSync(liveDir, { recursive: true })
      await materializeSnapshot({
        manifestSha256: baseScan.manifest_sha256,
        targetDir: liveDir,
      })
      writeFileSync(join(liveDir, "x.txt"), "L")
      await insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await updateFileMount(db, await mountId(client, sessionId), {
        status: "active",
      })

      // DEFAULT reconcile + applyHead (real helper). runInTx FAILS — modeling the
      // pending-record persist failing. Because persist precedes applyHead, the
      // live loser must survive + base must not advance.
      await assert.rejects(
        commitSpaces(sessionId, ["actor"], {
          dbh: db,
          runInTx: async () => {
            throw new Error("simulated pending-persist failure")
          },
          loadCtx: async () => ({ workspaceId, conversationId, actorId }),
        }),
        /pending-persist failure/,
        "persist failure propagates"
      )

      // THE KEY ASSERTION (P1): the live conflict path STILL holds the agent's
      // loser "L" (head was NOT applied — persist precedes the destructive apply),
      // so next turn working != head re-derives the conflict (no silent loss).
      assert.equal(
        readFileSync(join(liveDir, "x.txt"), "utf8"),
        "L",
        "live loser must survive when the pending persist failed (apply is deferred)"
      )
      // base did not advance.
      const mounts = await getActiveMountsForSession(db, sessionId)
      const actorMount = mounts.find((m) => m.mountSubpath === "actor")!
      assert.equal(
        actorMount.baseSnapshotId,
        baseSnap.id,
        "base must stay at the OLD base when the pending persist failed"
      )
    })
  }
)

test(
  "commitSpaces: P1 — a SUCCESSFUL conflict commit (default helper) persists pending, overwrites the live loser with head, and advances base",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    // The happy path of the deferred-apply ordering: persist succeeds, so applyHead
    // runs (live path → head "B") and base advances to latest. Proves the deferred
    // overwrite is actually applied once the record is durable.
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, conversationId, sessionId } = await seed(db)

      const work = mkdtempSync(join(tmpdir(), "synapse-p1-ok-"))
      const baseDir = join(work, "base")
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(join(baseDir, "x.txt"), "A")
      const baseScan = await scanCommitDir({ dir: baseDir })
      await ingest(db, baseScan)
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
      writeFileSync(join(headDir, "x.txt"), "B")
      const headScan = await scanCommitDir({ dir: headDir })
      await ingest(db, headScan)
      const headSnap = await appendSnapshot(db, {
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
      await insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: baseSnap.id,
        materializedDir: liveDir,
      })
      await updateFileMount(db, await mountId(client, sessionId), {
        status: "active",
      })

      // DEFAULT reconcile + applyHead + a real (passthrough) runInTx.
      const result = await commitSpaces(sessionId, ["actor"], {
        dbh: db,
        runInTx: async (fn) => fn(db),
        loadCtx: async () => ({ workspaceId, conversationId, actorId }),
      })

      assert.ok(
        result.conflictsBySubpath.actor?.includes("/x.txt"),
        "x.txt reported as a commit conflict"
      )
      // applyHead ran → live path now holds head "B" (the loser was overwritten).
      assert.equal(
        readFileSync(join(liveDir, "x.txt"), "utf8"),
        "B",
        "live path overwritten with head after the pending record persisted"
      )
      // The agent's loser is preserved at a sidecar (so it isn't lost).
      const sc = result.sidecarsBySubpath.actor?.[0]
      assert.equal(sc?.original, "/actor/x.txt", "loser preserved at a sidecar")
      assert.ok(sc?.contentSha, "sidecar carries the CAS-durable content sha")
      // base advanced to latest (equals-latest branch).
      const mounts = await getActiveMountsForSession(db, sessionId)
      const actorMount = mounts.find((m) => m.mountSubpath === "actor")!
      assert.equal(
        actorMount.baseSnapshotId,
        headSnap.id,
        "base advanced to head once the live dir == committed"
      )
      // The pending conflict was durably recorded with its sidecar.
      const stateRow = await client.query(
        `SELECT collaboration_state FROM sessions WHERE id = $1`,
        [sessionId]
      )
      const pending = (stateRow.rows[0]?.collaboration_state ?? {})[
        "_sandboxPendingCommitConflicts"
      ]
      assert.deepEqual(pending?.actor?.paths, ["/x.txt"])
      assert.equal(pending?.actor?.sidecars?.[0]?.original, "/actor/x.txt")
    })
  }
)
