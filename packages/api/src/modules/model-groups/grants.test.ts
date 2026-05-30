import test from "node:test"
import assert from "node:assert/strict"
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
      password_hash: "unused-hash",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspace(db: AnyDb, ownerId: string): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({
      owner_id: ownerId,
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
    .insertInto("workspace_members")
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      trust_level: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const row = await db
    .insertInto("actors")
    .values({
      workspace_id: workspaceId,
      name: "test actor",
      role: "assistant",
      title: "test",
      current_version: 1,
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
    .insertInto("model_groups")
    .values({
      owner_type: "workspace",
      owner_workspace_id: workspaceId,
      name: `g-${Math.random().toString(36).slice(2, 8)}`,
      description: "",
      routing_strategy: "priority_failover",
      attempt_policy: {} as any,
      is_default: false,
      is_enabled: true,
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
        .insertInto("model_group_grants")
        .values({
          group_id: groupId,
          subject_id: subjectId,
          status: "active",
        })
        .execute()
      const row = await db
        .selectFrom("model_group_grants as mgg")
        .innerJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
        .select(["mgs.kind", "mgs.workspace_id"])
        .where("mgg.group_id", "=", groupId)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "platform")
      assert.equal(row.workspace_id, null)
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
        .insertInto("model_group_grants")
        .values({
          group_id: groupId,
          subject_id: subjectId,
          status: "active",
        })
        .execute()
      const row = await db
        .selectFrom("model_group_grants as mgg")
        .innerJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
        .select(["mgs.kind", "mgs.workspace_id"])
        .where("mgg.group_id", "=", groupId)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "workspace")
      assert.equal(row.workspace_id, workspaceId)
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
        .insertInto("model_group_grants")
        .values({
          group_id: groupId,
          subject_id: subjectId,
          status: "active",
        })
        .execute()
      const row = await db
        .selectFrom("model_group_grants as mgg")
        .innerJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
        .select(["mgs.kind", "mgs.workspace_id", "mgs.workspace_member_id"])
        .where("mgg.group_id", "=", groupId)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "workspace_member")
      assert.equal(row.workspace_member_id, memberId)
      // Denormalized — should equal the member's owning workspace.
      assert.equal(row.workspace_id, workspaceId)
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
        .insertInto("model_group_grants")
        .values({
          group_id: groupId,
          subject_id: subjectId,
          status: "active",
        })
        .execute()
      const row = await db
        .selectFrom("model_group_grants as mgg")
        .innerJoin("access_subjects as mgs", "mgs.id", "mgg.subject_id")
        .select(["mgs.kind", "mgs.actor_id", "mgs.workspace_id"])
        .where("mgg.group_id", "=", groupId)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "actor")
      assert.equal(row.actor_id, actorId)
      assert.equal(row.workspace_id, workspaceId)
    })
  }
)

test(
  "model_group_grants.subject_id FK cascades when the access_subjects row is deleted",
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
        .insertInto("model_group_grants")
        .values({
          group_id: groupId,
          subject_id: subjectId,
          status: "active",
        })
        .execute()
      // Deleting the workspace_member cascades into access_subjects (subject's
      // workspace_member_id has ON DELETE CASCADE), which in turn cascades
      // into model_group_grants (deferred FK has ON DELETE CASCADE).
      await db
        .deleteFrom("workspace_members")
        .where("id", "=", memberId)
        .execute()
      const after = await db
        .selectFrom("model_group_grants")
        .select("id")
        .where("group_id", "=", groupId)
        .execute()
      assert.equal(after.length, 0)
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
        .insertInto("model_group_grants")
        .values({
          group_id: groupId,
          subject_id: subjectId,
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
          .insertInto("model_group_grants")
          .values({
            group_id: groupId,
            subject_id: subjectId,
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
        .insertInto("model_group_grants")
        .values({
          group_id: groupId,
          subject_id: subjectId,
          status: "active",
        })
        .execute()
      await db
        .updateTable("model_group_grants")
        .set({ status: "revoked", revoked_at: new Date() } as any)
        .where("group_id", "=", groupId)
        .execute()
      await db
        .insertInto("model_group_grants")
        .values({
          group_id: groupId,
          subject_id: subjectId,
          status: "active",
        })
        .execute()
      const active = await db
        .selectFrom("model_group_grants")
        .select("id")
        .where("group_id", "=", groupId)
        .where("status", "=", "active")
        .execute()
      assert.equal(active.length, 1)
    })
  }
)
