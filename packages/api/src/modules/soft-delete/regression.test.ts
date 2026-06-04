import test from "node:test"
import assert from "node:assert/strict"
import { sql } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import {
  markUserDeleted,
  markWorkspaceDeleted,
  revokeAuthRuntimeForUser,
} from "./orchestration.js"

type AnyDb = import("kysely").Kysely<any>

// Soft-delete cutover regression suite (design §8.5 DoD). Verifies the DB
// enforcement layer + orchestration end-to-end against a real (testcontainer)
// schema. Each test runs in the shared rolled-back transaction; statements that
// must fail are wrapped in a SAVEPOINT so the abort doesn't poison the tx.

let _seq = 0
const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${_seq++}`

async function insertUser(db: AnyDb, email?: string): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({ email: email ?? `${uniq("u")}@example.test`, name: "t" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
async function insertWorkspace(
  db: AnyDb,
  ownerId: string,
  slug?: string
): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({ owner_id: ownerId, slug: slug ?? uniq("ws"), name: "w" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
async function insertMember(
  db: AnyDb,
  ws: string,
  user: string,
  trust = "member"
): Promise<string> {
  const row = await db
    .insertInto("workspace_members")
    .values({ workspace_id: ws, user_id: user, trust_level: trust })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
async function insertActor(db: AnyDb, ws: string): Promise<string> {
  const row = await db
    .insertInto("actors")
    .values({
      workspace_id: ws,
      name: "a",
      role: "assistant",
      title: "t",
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
async function rejects(db: AnyDb, fn: () => Promise<unknown>, re: RegExp) {
  await sql`SAVEPOINT sd_probe`.execute(db)
  await assert.rejects(fn, re)
  await sql`ROLLBACK TO SAVEPOINT sd_probe`.execute(db)
}

test(
  "reject-delete: hard DELETE of a root is forbidden",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const actorId = await insertActor(db, ws)
      await rejects(
        db,
        () => db.deleteFrom("workspaces").where("id", "=", ws).execute(),
        /hard delete of workspaces is forbidden/
      )
      await rejects(
        db,
        () => db.deleteFrom("actors").where("id", "=", actorId).execute(),
        /hard delete of actors is forbidden/
      )
    })
  }
)

test(
  "FK-liveness: inserting a child of a soft-deleted parent is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      await db
        .updateTable("workspaces")
        .set({ deleted_at: new Date() })
        .where("id", "=", ws)
        .execute()
      await rejects(
        db,
        () =>
          db
            .insertInto("actors")
            .values({
              workspace_id: ws,
              name: "x",
              role: "assistant",
              title: "t",
            })
            .execute(),
        /references soft-deleted workspaces/
      )
    })
  }
)

test(
  "FK-liveness allows the delete orchestration's own child status flips",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      await insertActor(db, ws)
      // markWorkspaceDeleted flips the workspace deleted_at then soft-deletes
      // children — none of those UPDATEs may be blocked by the FK-liveness trigger.
      await markWorkspaceDeleted(db, ws)
      const liveActors = await db
        .selectFrom("actors")
        .select("id")
        .where("workspace_id", "=", ws)
        .where("deleted_at", "is", null)
        .execute()
      assert.equal(liveActors.length, 0, "all workspace actors soft-deleted")
    })
  }
)

test(
  "partial unique: a soft-deleted user's email can be re-registered",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const email = `${uniq("re")}@example.test`
      const u1 = await insertUser(db, email)
      // soft-delete + anonymize releases the email
      await markUserDeleted(db, u1)
      // a fresh user can now take the original email
      const u2 = await insertUser(db, email)
      assert.notEqual(u1, u2)
      const live = await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", email)
        .where("deleted_at", "is", null)
        .execute()
      assert.equal(live.length, 1, "exactly one live user holds the email")
    })
  }
)

test(
  "workspaces_live hides a soft-deleted workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      await db
        .updateTable("workspaces")
        .set({ deleted_at: new Date() })
        .where("id", "=", ws)
        .execute()
      const base = await db
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", ws)
        .execute()
      const live = await db
        .selectFrom("workspaces_live")
        .select("id")
        .where("id", "=", ws)
        .execute()
      assert.equal(base.length, 1)
      assert.equal(live.length, 0)
    })
  }
)

test(
  "markUserDeleted: tombstones user, anonymizes account, revokes auth runtime, removes membership",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      await insertMember(db, ws, u, "admin")
      await db
        .insertInto("account")
        .values({
          account_id: u,
          provider_id: "credential",
          user_id: u,
          password: "x",
        })
        .execute()
      await db
        .insertInto("session")
        .values({
          user_id: u,
          token: uniq("tok"),
          expires_at: new Date(Date.now() + 3600_000),
        })
        .execute()

      await markUserDeleted(db, u)

      const userRow = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", u)
        .executeTakeFirstOrThrow()
      assert.ok(userRow.deleted_at, "user tombstoned")
      assert.match(
        userRow.email as string,
        /@deleted\.invalid$/,
        "email anonymized"
      )
      const acct = await db
        .selectFrom("account")
        .selectAll()
        .where("user_id", "=", u)
        .executeTakeFirstOrThrow()
      assert.ok(acct.deleted_at, "account soft-deleted")
      assert.match(
        acct.account_id as string,
        /^deleted:/,
        "account_id anonymized"
      )
      assert.equal(acct.password, null, "credential cleared")
      const sessions = await db
        .selectFrom("session")
        .select("id")
        .where("user_id", "=", u)
        .execute()
      assert.equal(sessions.length, 0, "sessions revoked")
      const member = await db
        .selectFrom("workspace_members")
        .selectAll()
        .where("user_id", "=", u)
        .executeTakeFirstOrThrow()
      assert.equal(member.status, "removed", "membership removed")
    })
  }
)

test(
  "markUserDeleted: owned workspace transfers to a surviving admin",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const ws = await insertWorkspace(db, owner)
      await insertMember(db, ws, owner, "admin")
      const heir = await insertUser(db)
      await insertMember(db, ws, heir, "admin")

      await markUserDeleted(db, owner)

      const wsRow = await db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", ws)
        .executeTakeFirstOrThrow()
      assert.equal(
        wsRow.deleted_at,
        null,
        "workspace survives (owner transferred)"
      )
      assert.equal(
        wsRow.owner_id,
        heir,
        "ownership transferred to surviving admin"
      )
    })
  }
)

test(
  "markUserDeleted: owned workspace with no heir is soft-deleted",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const ws = await insertWorkspace(db, owner)
      await insertMember(db, ws, owner, "admin")

      await markUserDeleted(db, owner)

      const wsRow = await db
        .selectFrom("workspaces")
        .selectAll()
        .where("id", "=", ws)
        .executeTakeFirstOrThrow()
      assert.ok(wsRow.deleted_at, "workspace soft-deleted (no heir)")
    })
  }
)

test(
  "revokeAuthRuntimeForUser clears session + device_code in one call",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      await db
        .insertInto("session")
        .values({
          user_id: u,
          token: uniq("tok"),
          expires_at: new Date(Date.now() + 3600_000),
        })
        .execute()
      await db
        .insertInto("device_code")
        .values({
          device_code: uniq("dc"),
          user_code: uniq("uc"),
          user_id: u,
          expires_at: new Date(Date.now() + 3600_000),
          status: "approved",
        })
        .execute()

      await revokeAuthRuntimeForUser(db, u)

      assert.equal(
        (
          await db
            .selectFrom("session")
            .select("id")
            .where("user_id", "=", u)
            .execute()
        ).length,
        0
      )
      assert.equal(
        (
          await db
            .selectFrom("device_code")
            .select("id")
            .where("user_id", "=", u)
            .execute()
        ).length,
        0
      )
    })
  }
)

test(
  "GUC cannot forge a reject-delete bypass",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      // Setting an app GUC must NOT let the app role bypass the reject trigger —
      // the bypass is keyed on current_user, not a GUC.
      await sql`SELECT set_config('app.purge_ctx', 'true', true)`.execute(db)
      await rejects(
        db,
        () => db.deleteFrom("workspaces").where("id", "=", ws).execute(),
        /hard delete of workspaces is forbidden/
      )
    })
  }
)

test(
  "offline purge: sd_purge_workspace hard-erases a soft-deleted tenant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      await insertMember(db, ws, u, "admin")
      const actorId = await insertActor(db, ws)
      // soft-delete the tenant first (normal flow), then offline hard-erase
      await markWorkspaceDeleted(db, ws)
      await sql`SELECT sd_purge_workspace(${ws}::uuid)`.execute(db)
      const wsRows = await db
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", ws)
        .execute()
      const actorRows = await db
        .selectFrom("actors")
        .select("id")
        .where("id", "=", actorId)
        .execute()
      assert.equal(wsRows.length, 0, "workspace row physically gone")
      assert.equal(actorRows.length, 0, "actor row physically gone")
    })
  }
)

test(
  "offline purge: sd_purge_expired_soft_deleted removes old soft-deleted rows only",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const subj = await db
        .insertInto("access_subjects")
        .values({ kind: "workspace", workspace_id: ws })
        .returning("id")
        .executeTakeFirstOrThrow()
      // one old soft-deleted, one live memory_space
      await db
        .insertInto("memory_spaces")
        .values({
          workspace_id: ws,
          owner_subject_id: subj.id,
          namespace_key: "old",
          deleted_at: new Date(Date.now() - 100 * 864e5),
        })
        .execute()
      await db
        .insertInto("memory_spaces")
        .values({
          workspace_id: ws,
          owner_subject_id: subj.id,
          namespace_key: "live",
        })
        .execute()

      await sql`SELECT sd_purge_expired_soft_deleted(${new Date(Date.now() - 30 * 864e5).toISOString()}::timestamptz)`.execute(
        db
      )

      const rows = await db
        .selectFrom("memory_spaces")
        .select(["namespace_key"])
        .where("workspace_id", "=", ws)
        .execute()
      const keys = rows.map((r) => r.namespace_key).sort()
      assert.deepEqual(
        keys,
        ["live"],
        "only the old soft-deleted row was purged"
      )
    })
  }
)
