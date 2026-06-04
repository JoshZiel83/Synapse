import test from "node:test"
import assert from "node:assert/strict"
import { actorRef, conversationRef } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDbAndClient } from "../../test/helpers/db.js"
import {
  ensureFileSpace,
  insertFileMount,
  updateFileMount,
  appendSnapshot,
  ensureContentBlob,
  getActiveMountsForSession,
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
  const actor = await db
    .insertInto("actors")
    .values({
      workspace_id: ws.id,
      name: `actor-${rid()}`,
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
    assert.equal(conv1.current_snapshot_id, null)

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

    await ensureContentBlob(db, { sha256: SHA("a"), sizeBytes: 10 })
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
    assert.equal(afterV1?.current_snapshot_id, snap1.id)

    await ensureContentBlob(db, { sha256: SHA("b"), sizeBytes: 20 })
    const snap2 = await appendSnapshot(db, {
      workspaceId,
      fileSpaceId: space.id,
      expectedParentSnapshotId: snap1.id,
      manifestSha256: SHA("b"),
      entryCount: 2,
      totalBytes: 20,
    })
    assert.equal(String(snap2.version), "2")
    assert.equal(snap2.parent_snapshot_id, snap1.id)

    await ensureContentBlob(db, { sha256: SHA("c"), sizeBytes: 30 })
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
