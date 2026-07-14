import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { actorRef, conversationRef } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDbAndClient } from "../../test/helpers/db.js"
import { sql } from "kysely"
import {
  ensureFileSpace,
  insertFileMount,
  updateFileMount,
  appendSnapshot,
  ensureContentBlob,
  getActiveMountsForSession,
  claimFailedRecoverableMounts,
  releaseRecoveryClaims,
  sessionHasFailedRecoverableMounts,
  sandboxHasFailedRecoverableMounts,
  getFileSpace,
  SandboxSpaceError,
} from "./space.js"

/**
 * Sandbox file-space DB layer (space.ts). Exercises the ensureFileSpace upsert
 * (the three runtime spaces: /conversation owner=conversation, /actor and
 * /actor-conversation owner=actor), file_mount lifecycle, and the snapshot DAG
 * append with head-moved detection — all against the real schema (triggers,
 * composite FKs, partial-uniques).
 *
 * Uses withTestDbAndClient: the Kysely handle (db) is the Executor passed to
 * space.ts and also inserts fixtures; all share one rolled-back txn.
 */

const NS = "fss"
const SHA = (c: string) => c.repeat(64)

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function seedWorkspace(db: Kysely<any>) {
  const user = await db
    .insertInto("users")
    .values({ email: `${rid()}@${NS}`, name: "owner" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ owner_id: user.id, slug: `ws-${rid()}`, name: `${NS} ws` })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: ws.id,
      user_id: user.id,
      trust_level: "member",
    } as any)
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
      display_name: `actor-${rid()}`,
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
      title: `${NS} actor`,
      current_version: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({
      workspace_id: ws.id,
      kind: "direct",
      title: "t",
      created_by_workspace_member_id: member.id,
    } as any)
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

test("space.ts: ensureFileSpace creates 3 runtime spaces and is idempotent", async () => {
  await withTestDbAndClient(async ({ db }) => {
    const { workspaceId, actorId, conversationId } = await seedWorkspace(db)

    const conv1 = await ensureFileSpace(db, {
      workspaceId,
      owner: conversationRef(conversationId),
    })
    const actor1 = await ensureFileSpace(db, {
      workspaceId,
      owner: actorRef(actorId),
    })
    const actorConv1 = await ensureFileSpace(db, {
      workspaceId,
      owner: actorRef(actorId),
      scope: conversationRef(conversationId),
    })

    assert.notEqual(conv1.id, actor1.id)
    assert.notEqual(actor1.id, actorConv1.id)
    assert.notEqual(conv1.id, actorConv1.id)
    assert.equal(conv1.currentSnapshotId, null)

    const conv2 = await ensureFileSpace(db, {
      workspaceId,
      owner: conversationRef(conversationId),
    })
    const actorConv2 = await ensureFileSpace(db, {
      workspaceId,
      owner: actorRef(actorId),
      scope: conversationRef(conversationId),
    })
    assert.equal(conv2.id, conv1.id)
    assert.equal(actorConv2.id, actorConv1.id)
  })
})

test("space.ts: ensureFileSpace rejects a user-kind owner", async () => {
  await withTestDbAndClient(async ({ db }) => {
    const { workspaceId } = await seedWorkspace(db)
    await assert.rejects(
      () =>
        ensureFileSpace(db, {
          workspaceId,
          owner: {
            kind: "user",
            userId: "00000000-0000-4000-8000-000000000000",
          } as any,
        }),
      (err: unknown) => err instanceof SandboxSpaceError
    )
  })
})

test("space.ts: mount lifecycle + snapshot DAG + head-moved detection", async () => {
  await withTestDbAndClient(async ({ db }) => {
    const { workspaceId, actorId, sessionId } = await seedWorkspace(db)

    const space = await ensureFileSpace(db, {
      workspaceId,
      owner: actorRef(actorId),
    })

    const mount = await insertFileMount(db, {
      workspaceId,
      sessionId,
      fileSpaceId: space.id,
      mountSubpath: "actor",
      baseSnapshotId: null,
      materializedDir: "/tmp/sandbox/actor",
    })
    assert.equal(mount.status, "provisioning")

    const active = await getActiveMountsForSession(db, sessionId)
    assert.equal(active.length, 1)
    assert.equal(active[0].id, mount.id)

    await ensureContentBlob(db, {
      sha256: SHA("a"),
      sizeBytes: 10,
      backend: "local_cas",
    })
    const snap1 = await appendSnapshot(db, {
      workspaceId,
      fileSpaceId: space.id,
      expectedParentSnapshotId: null,
      manifestSha256: SHA("a"),
      entryCount: 1,
      totalBytes: 10,
      createdBySessionId: sessionId,
    })
    assert.equal(String(snap1.version), "1")

    const afterV1 = await getFileSpace(db, space.id)
    assert.equal(afterV1?.currentSnapshotId, snap1.id)

    await ensureContentBlob(db, {
      sha256: SHA("b"),
      sizeBytes: 20,
      backend: "local_cas",
    })
    const snap2 = await appendSnapshot(db, {
      workspaceId,
      fileSpaceId: space.id,
      expectedParentSnapshotId: snap1.id,
      manifestSha256: SHA("b"),
      entryCount: 2,
      totalBytes: 20,
    })
    assert.equal(String(snap2.version), "2")
    assert.equal(snap2.parentSnapshotId, snap1.id)

    await ensureContentBlob(db, {
      sha256: SHA("c"),
      sizeBytes: 30,
      backend: "local_cas",
    })
    await assert.rejects(
      () =>
        appendSnapshot(db, {
          workspaceId,
          fileSpaceId: space.id,
          expectedParentSnapshotId: snap1.id, // stale — head is snap2
          manifestSha256: SHA("c"),
          entryCount: 3,
          totalBytes: 30,
        }),
      (err: unknown) =>
        err instanceof SandboxSpaceError &&
        (err as SandboxSpaceError).status === 409
    )

    await updateFileMount(db, mount.id, {
      status: "closed",
      closedAt: true,
      resultSnapshotId: snap2.id,
    })
    const afterClose = await getActiveMountsForSession(db, sessionId)
    assert.equal(afterClose.length, 0)
  })
})

test("space.ts: active partial-unique forbids two live mounts for one subpath", async () => {
  await withTestDbAndClient(async ({ db }) => {
    const { workspaceId, actorId, sessionId } = await seedWorkspace(db)
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
    })
    const space2 = await ensureFileSpace(db, {
      workspaceId,
      owner: actorRef(actorId),
      namespaceKey: "other",
    })
    await assert.rejects(() =>
      insertFileMount(db, {
        workspaceId,
        sessionId,
        fileSpaceId: space2.id,
        mountSubpath: "actor",
        baseSnapshotId: null,
      })
    )
  })
})

// ── R6 H-2: 'recovering' is a durable recovery LEASE ────────────────────────────

/** Minimal sandbox runtime (runtimes + sandboxes) so a mount's sandbox_id FK resolves.
 *  State/adapter are arbitrary for the repo-space predicate tests (which query
 *  file_mounts by sandbox_id, not the sandbox state); the deferred mode<->service
 *  trigger never fires in a rolled-back test txn. */
async function insertSandboxRow(
  db: Kysely<any>,
  workspaceId: string,
  sessionId: string
): Promise<string> {
  const id = crypto.randomUUID()
  await db
    .insertInto("runtimes")
    .values({ id, workspace_id: workspaceId, kind: "sandbox" } as any)
    .execute()
  await sql`
    INSERT INTO sandboxes (id, workspace_id, session_id, mode, adapter, state, resource_id, platform, arch)
    VALUES (${id}, ${workspaceId}, ${sessionId}, 'bare', 'cubesandbox', 'active'::sandboxes_state, 'vm-x', 'linux', 'x64')`.execute(
    db
  )
  return id
}

test("space.ts (R6 H-2): claim leases failed→recovering — excluded from live mounts, still failed-recoverable; release resets it", async () => {
  await withTestDbAndClient(async ({ db }) => {
    const { workspaceId, actorId, sessionId } = await seedWorkspace(db)
    const space = await ensureFileSpace(db, {
      workspaceId,
      owner: actorRef(actorId),
    })
    const sandboxId = await insertSandboxRow(db, workspaceId, sessionId)
    const mount = await insertFileMount(db, {
      workspaceId,
      sessionId,
      fileSpaceId: space.id,
      mountSubpath: "actor",
      baseSnapshotId: null,
      materializedDir: "/tmp/preserved",
    })
    await updateFileMount(db, mount.id, { status: "failed", sandboxId })

    // CLAIM: failed → recovering, returned.
    const claimed = await claimFailedRecoverableMounts(db, 600)
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].id, mount.id)
    assert.equal(claimed[0].status, "recovering")

    // A leased mount is NOT a live mount (teardown/commit must not also grab it) ...
    const active = await getActiveMountsForSession(db, sessionId)
    assert.equal(
      active.length,
      0,
      "a 'recovering' lease is excluded from active mounts"
    )
    // ... but IS still failed-recoverable (its sole-source VM must be kept alive, and
    // the #4 data-free defer must keep deferring while it is mid-lease).
    assert.equal(await sessionHasFailedRecoverableMounts(db, sessionId), true)
    assert.equal(await sandboxHasFailedRecoverableMounts(db, sandboxId), true)

    // A second claim under the same TTL does NOT re-pick the fresh lease (no double-
    // recovery across replicas / the racing periodic sweep).
    const again = await claimFailedRecoverableMounts(db, 600)
    assert.equal(
      again.length,
      0,
      "a fresh lease is not re-claimed under the TTL"
    )

    // RELEASE (a clean, non-crash failure): recovering → failed, re-claimable at once.
    await releaseRecoveryClaims(db, [mount.id])
    const afterRelease = await claimFailedRecoverableMounts(db, 600)
    assert.equal(afterRelease.length, 1, "a released lease is re-claimable")
    assert.equal(afterRelease[0].id, mount.id)
  })
})

test("space.ts (R6 H-2): a crashed worker's stale 'recovering' lease is reclaimed once it ages past the TTL", async () => {
  await withTestDbAndClient(async ({ db }) => {
    const { workspaceId, actorId, sessionId } = await seedWorkspace(db)
    const space = await ensureFileSpace(db, {
      workspaceId,
      owner: actorRef(actorId),
    })
    const mount = await insertFileMount(db, {
      workspaceId,
      sessionId,
      fileSpaceId: space.id,
      mountSubpath: "actor",
      baseSnapshotId: null,
      materializedDir: "/tmp/preserved",
    })
    await updateFileMount(db, mount.id, { status: "failed" })

    const claimed = await claimFailedRecoverableMounts(db, 600)
    assert.equal(claimed.length, 1) // now 'recovering', updated_at = NOW()

    // A worker that crashed never released the lease. Under a POSITIVE TTL it stays held
    // (updated_at == the frozen txn NOW(), not yet older than the window).
    assert.equal((await claimFailedRecoverableMounts(db, 600)).length, 0)

    // Age the lease: backdate updated_at an hour into the past. The touch trigger stamps
    // updated_at=NOW() on every UPDATE, and the test txn freezes NOW(), so we disable the
    // trigger + write a real clock_timestamp() to genuinely age the row (not a time hack).
    await sql`ALTER TABLE file_mounts DISABLE TRIGGER trg_touch_updated_at__file_mounts`.execute(
      db
    )
    await sql`UPDATE file_mounts SET updated_at = clock_timestamp() - interval '1 hour' WHERE id = ${mount.id}`.execute(
      db
    )
    await sql`ALTER TABLE file_mounts ENABLE TRIGGER trg_touch_updated_at__file_mounts`.execute(
      db
    )

    // The stale lease (updated_at now < NOW() - 600s) is reclaimed by the next sweep.
    const reclaimed = await claimFailedRecoverableMounts(db, 600)
    assert.equal(reclaimed.length, 1, "a stale lease past the TTL is reclaimed")
    assert.equal(reclaimed[0].id, mount.id)
  })
})

test("space.ts (R6 H-2): a failed→recovering CAS never collides with a re-provisioned live mount for the same (session, space)", async () => {
  await withTestDbAndClient(async ({ db }) => {
    const { workspaceId, actorId, sessionId } = await seedWorkspace(db)
    const space = await ensureFileSpace(db, {
      workspaceId,
      owner: actorRef(actorId),
    })

    // Generation 1: a FAILED mount whose VM still holds unpulled bytes (excluded from
    // the active partial-unique because 'failed' is excluded).
    const failed = await insertFileMount(db, {
      workspaceId,
      sessionId,
      fileSpaceId: space.id,
      mountSubpath: "actor",
      baseSnapshotId: null,
      materializedDir: "/tmp/preserved",
    })
    await updateFileMount(db, failed.id, { status: "failed" })
    // Generation 2: the session was re-provisioned → a NEW live mount for the SAME
    // (session, space/subpath). A naive failed→recovering flip would re-enter the live
    // set and collide with THIS row on uq_file_mounts_active_session_subpath.
    const active = await insertFileMount(db, {
      workspaceId,
      sessionId,
      fileSpaceId: space.id,
      mountSubpath: "actor",
      baseSnapshotId: null,
      materializedDir: "/tmp/live",
    })
    await updateFileMount(db, active.id, { status: "active" })

    // The claim must NOT throw a unique violation — 'recovering' is excluded from the
    // active partial-unique, exactly like 'failed'.
    const claimed = await claimFailedRecoverableMounts(db, 600)
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].id, failed.id)
    assert.equal(claimed[0].status, "recovering")
    // The live generation-2 mount is untouched + still the only active mount.
    const stillActive = await getActiveMountsForSession(db, sessionId)
    assert.equal(stillActive.length, 1)
    assert.equal(stillActive[0].id, active.id)
  })
})
