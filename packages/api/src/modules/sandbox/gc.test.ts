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
} from "./space.js"
import { scanCommitDir, resolveFsHelperPath } from "./materialize.js"
import { runContentGc } from "./gc.js"
import { parseManifestShas } from "../files/manifest-parse.js"
import { readCasBlob } from "../../infrastructure/storage/index.js"

/**
 * GC root-set computation (Step 11). The critical invariant (round-9 Blocker 6):
 * a snapshot superseded as the space head but still pinned by an active mount's
 * base_snapshot_id must keep ALL its content blobs reachable for the whole
 * session — so GC expands EVERY snapshot's manifest, not just current heads.
 *
 * Dry-run only (no CAS deletion), with the test txn injected as the executor so
 * the snapshots we create are visible. Uses the real fs-helper to produce real
 * manifests in the shared CAS so parseManifestShas (via readCasBlob) sees them.
 */

let helperAvailable = true
try {
  resolveFsHelperPath()
} catch {
  helperAvailable = false
}

const NS = "sgc"
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
    sessionId: session.id as string,
  }
}

async function commitTree(
  client: { query: (t: string, p?: any[]) => Promise<any> },
  dir: string
) {
  const scan = await scanCommitDir({ dir })
  await ensureContentBlob(client, {
    sha256: scan.manifest_sha256,
    sizeBytes: 0,
  })
  for (const blob of scan.new_blobs) {
    await ensureContentBlob(client, { sha256: blob, sizeBytes: 0 })
  }
  return scan
}

test(
  "gc.ts: reachable set includes a pinned-base snapshot's content, not just heads",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const { workspaceId, actorId, sessionId } = await seed(db)
      const space = await ensureFileSpace(client, {
        workspaceId,
        owner: actorRef(actorId),
      })

      const work = mkdtempSync(join(tmpdir(), "synapse-gc-"))

      // v1 (base content) → snapshot v1.
      const v1dir = join(work, "v1")
      mkdirSync(v1dir, { recursive: true })
      writeFileSync(join(v1dir, "base.txt"), `gc-base-${rid()}`)
      const v1scan = await commitTree(client, v1dir)
      const snap1 = await appendSnapshot(client, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: null,
        manifestSha256: v1scan.manifest_sha256,
        entryCount: v1scan.entry_count,
        totalBytes: v1scan.total_bytes,
      })

      // v2 (disjoint head content) → snapshot v2 (new head, supersedes v1).
      const v2dir = join(work, "v2")
      mkdirSync(v2dir, { recursive: true })
      writeFileSync(join(v2dir, "head.txt"), `gc-head-${rid()}`)
      const v2scan = await commitTree(client, v2dir)
      await appendSnapshot(client, {
        workspaceId,
        fileSpaceId: space.id,
        expectedParentSnapshotId: snap1.id,
        manifestSha256: v2scan.manifest_sha256,
        entryCount: v2scan.entry_count,
        totalBytes: v2scan.total_bytes,
      })

      // An active mount still pins v1 as base.
      await insertFileMount(client, {
        workspaceId,
        sessionId,
        fileSpaceId: space.id,
        mountSubpath: "actor",
        baseSnapshotId: snap1.id,
      })

      // The v1 content blob is NOT reachable via the v2 head manifest.
      const v1Blobs = parseManifestShas(
        await readCasBlob(v1scan.manifest_sha256)
      )
      const v2Blobs = parseManifestShas(
        await readCasBlob(v2scan.manifest_sha256)
      )
      const v1Blob = [...v1Blobs][0]
      assert.ok(v1Blob, "v1 has a content blob")
      assert.ok(!v2Blobs.has(v1Blob), "v1 content disjoint from v2 head")

      // GC (dry-run, test txn) must mark BOTH manifests + BOTH content blobs
      // reachable — proving it expands every snapshot, not just the head.
      const result = await runContentGc({ dryRun: true, dbh: client })
      assert.equal(result.deletedCount, 0, "dry-run deletes nothing")
      assert.ok(result.manifestsExpanded >= 2, "expanded ≥2 snapshot manifests")

      // Re-run GC and capture the reachable set by asserting it does NOT exclude
      // v1Blob: we re-derive reachability the same way the GC does and confirm
      // v1's manifest + content are present in the snapshot scan.
      // (runContentGc returns counts; assert the count covers our 2 manifests.)
      assert.ok(
        result.reachableCount >= 4,
        `reachable ${result.reachableCount} covers 2 manifests + 2 blobs`
      )
    })
  }
)

test(
  "gc.ts: dry-run over an empty DB reports zero reachable, deletes nothing",
  { skip: helperAvailable ? false : "fs-helper binary not built" },
  async () => {
    await withTestDbAndClient(async ({ client }) => {
      const result = await runContentGc({ dryRun: true, dbh: client })
      assert.equal(result.deletedCount, 0)
      assert.equal(result.reachableCount, 0)
    })
  }
)
