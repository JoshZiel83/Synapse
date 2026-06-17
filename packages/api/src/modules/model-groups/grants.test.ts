import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { sql } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { SUBJECT_KIND } from "@synapse/shared"

type AnyDb = import("kysely").Kysely<any>

// These tests exercise the P1b model_group_grants schema migration directly
// through the trx-scoped Kysely instance. The model-groups *service* still
// imports the global db (not DI'd, see P0/P6 follow-ups) so we can't call
// service.ts from inside withTestDb. Hitting the schema via the trx is the
// load-bearing assertion: subject_id resolves through access_subjects, the
// dropped polymorphic columns are gone, and the deferred FK constraint holds.

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "test user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspace(db: AnyDb, ownerId: string): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({
      ownerId: ownerId,
      slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
      name: "test workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspaceMember(
  db: AnyDb,
  workspaceId: string,
  userId: string
): Promise<string> {
  const row = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspaceId,
      userId: userId,
      trustLevel: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const actorId = crypto.randomUUID()
  await db
    .insertInto("workspaceApps")
    .values({
      id: actorId,
      workspaceId: workspaceId,
      kind: "actor",
      displayName: "test actor",
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: "test",
      currentVersion: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertModelGroup(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("modelGroups")
    .values({
      ownerType: "workspace",
      ownerWorkspaceId: workspaceId,
      name: `g-${Math.random().toString(36).slice(2, 8)}`,
      description: "",
      routingStrategy: "priority_failover",
      attemptPolicy: {} as any,
      isDefault: false,
      isEnabled: true,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "model_group_grants accepts a platform-kind subject_id (platform scope)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const groupId = await insertModelGroup(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.PLATFORM,
      })
      await db
        .insertInto("modelGroupGrants")
        .values({
          groupId: groupId,
          subjectId: subjectId,
          status: "active",
        })
        .execute()
      const row = await db
        .selectFrom("modelGroupGrants as mgg")
        .innerJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
        .select(["mgs.kind", "mgs.workspaceId"])
        .where("mgg.groupId", "=", groupId)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "platform")
      assert.equal(row.workspaceId, null)
    })
  }
)

test(
  "model_group_grants accepts a workspace-kind subject_id (workspace scope)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const groupId = await insertModelGroup(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      await db
        .insertInto("modelGroupGrants")
        .values({
          groupId: groupId,
          subjectId: subjectId,
          status: "active",
        })
        .execute()
      const row = await db
        .selectFrom("modelGroupGrants as mgg")
        .innerJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
        .select(["mgs.kind", "mgs.workspaceId"])
        .where("mgg.groupId", "=", groupId)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "workspace")
      assert.equal(row.workspaceId, workspaceId)
    })
  }
)

test(
  "model_group_grants accepts a workspace_member-kind subject_id and auto-populates the owning workspace_id",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const groupId = await insertModelGroup(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })
      await db
        .insertInto("modelGroupGrants")
        .values({
          groupId: groupId,
          subjectId: subjectId,
          status: "active",
        })
        .execute()
      const row = await db
        .selectFrom("modelGroupGrants as mgg")
        .innerJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
        .select(["mgs.kind", "mgs.workspaceId", "mgs.workspaceMemberId"])
        .where("mgg.groupId", "=", groupId)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "workspace_member")
      assert.equal(row.workspaceMemberId, memberId)
      // Denormalized — should equal the member's owning workspace.
      assert.equal(row.workspaceId, workspaceId)
    })
  }
)

test(
  "model_group_grants accepts an actor-kind subject_id and auto-populates the owning workspace_id",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const groupId = await insertModelGroup(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      await db
        .insertInto("modelGroupGrants")
        .values({
          groupId: groupId,
          subjectId: subjectId,
          status: "active",
        })
        .execute()
      const row = await db
        .selectFrom("modelGroupGrants as mgg")
        .innerJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
        .select(["mgs.kind", "mgs.actorId", "mgs.workspaceId"])
        .where("mgg.groupId", "=", groupId)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "actor")
      assert.equal(row.actorId, actorId)
      assert.equal(row.workspaceId, workspaceId)
    })
  }
)

test(
  "workspace_members cannot be hard-deleted (soft-delete reject trigger); member status flips instead, grant + subject rows are preserved",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const groupId = await insertModelGroup(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })
      await db
        .insertInto("modelGroupGrants")
        .values({
          groupId: groupId,
          subjectId: subjectId,
          status: "active",
        })
        .execute()

      // Soft-delete world (design §0/§7): hard-deleting a workspace_member is
      // forbidden by the sd_reject_delete trigger — there is no DB cascade.
      // Wrap in a manual SAVEPOINT so the rejected statement's abort doesn't
      // poison the outer test transaction (Kysely has no nested .transaction()).
      await sql`SAVEPOINT sd_reject_probe`.execute(db)
      await assert.rejects(
        () =>
          db
            .deleteFrom("workspaceMembers")
            .where("id", "=", memberId)
            .execute(),
        /hard delete of workspace_members is forbidden/
      )
      await sql`ROLLBACK TO SAVEPOINT sd_reject_probe`.execute(db)

      // The lifecycle is a status flip (member id stays stable, §6). The
      // access_subjects row is an immutable identity registry (§5) — it stays,
      // and the grant row stays too (no cascade). Availability is derived from
      // the underlying member's status, not from row deletion.
      await db
        .updateTable("workspaceMembers")
        .set({ status: "removed", removedAt: new Date() })
        .where("id", "=", memberId)
        .execute()

      const subjectAfter = await db
        .selectFrom("accessSubjects")
        .select("id")
        .where("id", "=", subjectId)
        .execute()
      assert.equal(
        subjectAfter.length,
        1,
        "access_subjects row is preserved (immutable registry)"
      )

      const grantAfter = await db
        .selectFrom("modelGroupGrants")
        .select(["id", "status"])
        .where("groupId", "=", groupId)
        .execute()
      assert.equal(grantAfter.length, 1, "grant row is preserved (no cascade)")
    })
  }
)

// P1b concurrency: two concurrent INSERTs targeting the same (group, subject)
// pair must produce at most one active row even when both pass the
// pre-flight existence check. The partial unique index
// `uq_model_group_grants_active_subject` enforces this at the DB level.
test(
  "model_group_grants enforces at-most-one active grant per (group, subject) via partial unique index",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const groupId = await insertModelGroup(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      await db
        .insertInto("modelGroupGrants")
        .values({
          groupId: groupId,
          subjectId: subjectId,
          status: "active",
        })
        .execute()

      // A unique violation aborts the surrounding transaction, so we have to
      // wrap the duplicate INSERT in a SAVEPOINT and roll back to it on
      // failure so the test transaction can continue.
      let dupErrorMessage = ""
      await sql`SAVEPOINT dup_attempt`.execute(db)
      try {
        await db
          .insertInto("modelGroupGrants")
          .values({
            groupId: groupId,
            subjectId: subjectId,
            status: "active",
          })
          .execute()
      } catch (err) {
        dupErrorMessage = String((err as Error)?.message ?? "")
        await sql`ROLLBACK TO SAVEPOINT dup_attempt`.execute(db)
      }
      await sql`RELEASE SAVEPOINT dup_attempt`.execute(db).catch(() => {})
      assert.notEqual(dupErrorMessage, "")
      assert.match(
        dupErrorMessage,
        /uq_model_group_grants_active_subject|duplicate key/i
      )
    })
  }
)

// Revoked rows must NOT block a new active grant (the partial index is
// scoped to WHERE status = 'active').
test(
  "model_group_grants partial unique index allows re-granting after revoke",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const groupId = await insertModelGroup(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      await db
        .insertInto("modelGroupGrants")
        .values({
          groupId: groupId,
          subjectId: subjectId,
          status: "active",
        })
        .execute()
      await db
        .updateTable("modelGroupGrants")
        .set({ status: "revoked", revokedAt: new Date() } as any)
        .where("groupId", "=", groupId)
        .execute()
      await db
        .insertInto("modelGroupGrants")
        .values({
          groupId: groupId,
          subjectId: subjectId,
          status: "active",
        })
        .execute()
      const active = await db
        .selectFrom("modelGroupGrants")
        .select("id")
        .where("groupId", "=", groupId)
        .where("status", "=", "active")
        .execute()
      assert.equal(active.length, 1)
    })
  }
)
