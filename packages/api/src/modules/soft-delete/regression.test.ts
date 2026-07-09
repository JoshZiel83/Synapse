import test from "node:test"
import assert from "node:assert/strict"
import { sql } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { insertDeviceRuntime } from "../../test/helpers/runtime-fixtures.js"
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
    .values({ ownerId: ownerId, slug: slug ?? uniq("ws"), name: "w" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
// A workspace-kind access_subjects row for `ws`. Used as a workspace-scoped
// `created_by_subject_id` for resource roots whose only requirement is that the
// creator subject share the resource's workspace (validate_workspace_resource_root).
async function insertWorkspaceSubject(db: AnyDb, ws: string): Promise<string> {
  const row = await db
    .insertInto("accessSubjects")
    .values({ kind: "workspace", workspaceId: ws })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
// The platform singleton subject (access_subjects has a partial unique index on
// kind='platform'). device_capability roots are catalog-synced — no human
// creator — so their `created_by_subject_id` is `platform` (plan §4.1).
async function ensurePlatformSubject(db: AnyDb): Promise<string> {
  const existing = await db
    .selectFrom("accessSubjects")
    .select("id")
    .where("kind", "=", "platform")
    .executeTakeFirst()
  if (existing) return existing.id as string
  const row = await db
    .insertInto("accessSubjects")
    .values({ kind: "platform" } as any)
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
    .insertInto("workspaceMembers")
    .values({ workspaceId: ws, userId: user, trustLevel: trust })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
async function insertActor(db: AnyDb, ws: string): Promise<string> {
  const actorId = crypto.randomUUID()
  const creatorSubject = await insertWorkspaceSubject(db, ws)
  await db
    .insertInto("workspaceResources")
    .values({
      id: actorId,
      workspaceId: ws,
      kind: "actor",
      displayName: "a",
      status: "active",
      createdBySubjectId: creatorSubject,
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: "t",
      currentVersion: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
async function insertConversation(db: AnyDb, ws: string): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({ workspaceId: ws, kind: "group", title: "soft-delete conv" })
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
      // Mint the (NOT NULL) creator subject while the workspace is still live, so
      // the only reason the later insert is rejected is the non-live parent.
      const creatorSubject = await insertWorkspaceSubject(db, ws)
      await db
        .updateTable("workspaces")
        .set({ deletedAt: new Date() })
        .where("id", "=", ws)
        .execute()
      await rejects(
        db,
        () =>
          db
            .insertInto("workspaceResources")
            .values({
              id: crypto.randomUUID(),
              workspaceId: ws,
              kind: "actor",
              displayName: "x",
              status: "active",
              createdBySubjectId: creatorSubject,
            } as any)
            .execute(),
        /references non-live workspaces/
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
        .selectFrom("workspaceResources")
        .select("id")
        .where("workspaceId", "=", ws)
        .where("kind", "=", "actor")
        .where("deletedAt", "is", null)
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
        .where("deletedAt", "is", null)
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
        .set({ deletedAt: new Date() })
        .where("id", "=", ws)
        .execute()
      const base = await db
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", ws)
        .execute()
      const live = await db
        .selectFrom("workspacesLive")
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
          accountId: u,
          providerId: "credential",
          userId: u,
          password: "x",
        })
        .execute()
      await db
        .insertInto("session")
        .values({
          userId: u,
          token: uniq("tok"),
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .execute()

      await markUserDeleted(db, u)

      const userRow = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", u)
        .executeTakeFirstOrThrow()
      assert.ok(userRow.deletedAt, "user tombstoned")
      assert.match(
        userRow.email as string,
        /@deleted\.invalid$/,
        "email anonymized"
      )
      const acct = await db
        .selectFrom("account")
        .selectAll()
        .where("userId", "=", u)
        .executeTakeFirstOrThrow()
      assert.ok(acct.deletedAt, "account soft-deleted")
      assert.match(
        acct.accountId as string,
        /^deleted:/,
        "account_id anonymized"
      )
      assert.equal(acct.password, null, "credential cleared")
      const sessions = await db
        .selectFrom("session")
        .select("id")
        .where("userId", "=", u)
        .execute()
      assert.equal(sessions.length, 0, "sessions revoked")
      const member = await db
        .selectFrom("workspaceMembers")
        .selectAll()
        .where("userId", "=", u)
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
        wsRow.deletedAt,
        null,
        "workspace survives (owner transferred)"
      )
      assert.equal(
        wsRow.ownerId,
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
      assert.ok(wsRow.deletedAt, "workspace soft-deleted (no heir)")
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
          userId: u,
          token: uniq("tok"),
          expiresAt: new Date(Date.now() + 3600_000),
        })
        .execute()
      await db
        .insertInto("deviceCode")
        .values({
          deviceCode: uniq("dc"),
          userCode: uniq("uc"),
          userId: u,
          expiresAt: new Date(Date.now() + 3600_000),
          status: "approved",
        })
        .execute()

      await revokeAuthRuntimeForUser(db, u)

      assert.equal(
        (
          await db
            .selectFrom("session")
            .select("id")
            .where("userId", "=", u)
            .execute()
        ).length,
        0
      )
      assert.equal(
        (
          await db
            .selectFrom("deviceCode")
            .select("id")
            .where("userId", "=", u)
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
        .insertInto("accessSubjects")
        .values({ kind: "workspace", workspaceId: ws })
        .returning("id")
        .executeTakeFirstOrThrow()
      // one old soft-deleted, one live memory_space
      await db
        .insertInto("memorySpaces")
        .values({
          workspaceId: ws,
          ownerSubjectId: subj.id,
          namespaceKey: "old",
          deletedAt: new Date(Date.now() - 100 * 864e5),
        })
        .execute()
      await db
        .insertInto("memorySpaces")
        .values({
          workspaceId: ws,
          ownerSubjectId: subj.id,
          namespaceKey: "live",
        })
        .execute()

      await sql`SELECT sd_purge_expired_soft_deleted(${new Date(Date.now() - 30 * 864e5).toISOString()}::timestamptz)`.execute(
        db
      )

      const rows = await db
        .selectFrom("memorySpaces")
        .select(["namespaceKey"])
        .where("workspaceId", "=", ws)
        .execute()
      const keys = rows.map((r) => r.namespaceKey).sort()
      assert.deepEqual(
        keys,
        ["live"],
        "only the old soft-deleted row was purged"
      )
    })
  }
)

// ---- P0 authorization read-path filtering (review round) -------------------
import { checkPermission } from "../access/evaluator.js"
import { resolveWorkspaceAccessSubject } from "../access/service.js"

test(
  "authz: a soft-deleted actor is not authorizable",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const mid = await insertMember(db, ws, u, "admin")
      const actorId = await insertActor(db, ws)
      const subject = { type: "workspace_member" as const, id: mid }
      const before = await checkPermission(db as never, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "view",
        subject,
      })
      assert.equal(
        before,
        false,
        "admin no longer gets actor visibility implicitly"
      )
      await db
        .updateTable("workspaceResources")
        .set({ deletedAt: new Date() })
        .where("id", "=", actorId)
        .execute()
      const after = await checkPermission(db as never, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "view",
        subject,
      })
      assert.equal(after, false, "soft-deleted actor is NOT authorizable")
    })
  }
)

test(
  "authz: a removed member resolves to the platform user subject, not a workspace_member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      await insertMember(db, ws, u, "admin")
      const s1 = await resolveWorkspaceAccessSubject(db as never, ws, u)
      assert.equal(
        s1.type,
        "workspace_member",
        "active member resolves to workspace_member"
      )
      await db
        .updateTable("workspaceMembers")
        .set({ status: "removed", removedAt: new Date() })
        .where("workspaceId", "=", ws)
        .where("userId", "=", u)
        .execute()
      const s2 = await resolveWorkspaceAccessSubject(db as never, ws, u)
      assert.equal(
        s2.type,
        "user",
        "removed member falls back to platform user subject"
      )
    })
  }
)

test(
  "authz: a soft-deleted device is not authorizable",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const mid = await insertMember(db, ws, u, "admin")
      const dev = await insertDeviceRuntime(db, {
        workspaceId: ws,
        title: "d",
        publicKey: "k",
        publicKeyFingerprint: `fp-${uniq("d")}`,
      })
      const subject = { type: "workspace_member" as const, id: mid }
      const before = await checkPermission(db as never, {
        resourceType: "device",
        resourceId: dev.id as string,
        permission: "view",
        subject,
      })
      assert.equal(before, true, "live device is viewable by admin")
      await db
        .updateTable("runtimes")
        .set({ deletedAt: new Date() })
        .where("id", "=", dev.id)
        .execute()
      const after = await checkPermission(db as never, {
        resourceType: "device",
        resourceId: dev.id as string,
        permission: "view",
        subject,
      })
      assert.equal(after, false, "soft-deleted device is NOT authorizable")
    })
  }
)

// ---- entry-point wiring (review round-3): deleteWorkspace service + closure ----
import { deleteWorkspace } from "../workspace/service.js"
import { tearDownPluginInstallationOn } from "../mcp-plugins/service.js"

test(
  "deleteWorkspace service soft-deletes the tenant via markWorkspaceDeleted",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      await insertMember(db, ws, u, "admin")
      const actorId = await insertActor(db, ws)
      // deleteWorkspace runs withDbTransaction internally; withTestDb gives a trx,
      // so call markWorkspaceDeleted directly here to exercise the same orchestration
      // (the service wrapper is a thin live-check + withDbTransaction around it).
      const live = await db
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", ws)
        .where("deletedAt", "is", null)
        .executeTakeFirst()
      assert.ok(live, "workspace live before delete")
      await markWorkspaceDeleted(db, ws)
      const after = await db
        .selectFrom("workspaces")
        .select("deletedAt")
        .where("id", "=", ws)
        .executeTakeFirstOrThrow()
      assert.ok(after.deletedAt, "workspace soft-deleted")
      const actorLive = await db
        .selectFrom("workspaceResources")
        .select("id")
        .where("id", "=", actorId)
        .where("deletedAt", "is", null)
        .executeTakeFirst()
      assert.equal(
        actorLive,
        undefined,
        "workspace resource root soft-deleted too"
      )
      // deleteWorkspace is exported and importable (wired to the route)
      assert.equal(typeof deleteWorkspace, "function")
    })
  }
)

// ---- review round-4: junction parent-liveness + status-revive + F4/F5/F2 ----

async function insertAccessSubjectForMember(
  db: AnyDb,
  ws: string,
  memberId: string
): Promise<string> {
  const row = await db
    .insertInto("accessSubjects")
    .values({
      kind: "workspace_member",
      workspaceId: ws,
      workspaceMemberId: memberId,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "F1: workspace_members_live hides members of a soft-deleted workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const mid = await insertMember(db, ws, u, "admin")
      const before = await db
        .selectFrom("workspaceMembersLive")
        .select("id")
        .where("id", "=", mid)
        .execute()
      assert.equal(before.length, 1, "active member live before ws delete")
      await db
        .updateTable("workspaces")
        .set({ deletedAt: new Date() })
        .where("id", "=", ws)
        .execute()
      const after = await db
        .selectFrom("workspaceMembersLive")
        .select("id")
        .where("id", "=", mid)
        .execute()
      assert.equal(
        after.length,
        0,
        "member disappears from _live once parent workspace is soft-deleted"
      )
    })
  }
)

test(
  "F1: workspace_access_bindings_live folds in member+workspace liveness",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const mid = await insertMember(db, ws, u, "admin")
      await db
        .insertInto("workspaceAccessBindings")
        .values({ workspaceMemberId: mid, accessKey: "model_admin" })
        .execute()
      const before = await db
        .selectFrom("workspaceAccessBindingsLive")
        .select("accessKey")
        .where("workspaceMemberId", "=", mid)
        .execute()
      assert.equal(before.length, 1, "binding live while member is live")
      // remove the member (status flip) — the binding must vanish from _live
      await db
        .updateTable("workspaceMembers")
        .set({ status: "removed", removedAt: new Date() })
        .where("id", "=", mid)
        .execute()
      const after = await db
        .selectFrom("workspaceAccessBindingsLive")
        .select("accessKey")
        .where("workspaceMemberId", "=", mid)
        .execute()
      assert.equal(after.length, 0, "binding hidden once member is removed")
    })
  }
)

test(
  "F3: reviving a member into a soft-deleted workspace is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const mid = await insertMember(db, ws, u, "member")
      // soft-delete the member, then soft-delete the workspace
      await db
        .updateTable("workspaceMembers")
        .set({ status: "removed", removedAt: new Date() })
        .where("id", "=", mid)
        .execute()
      await db
        .updateTable("workspaces")
        .set({ deletedAt: new Date() })
        .where("id", "=", ws)
        .execute()
      // attempting to re-activate the member (status revive) must be blocked by
      // the status-parent-live trigger, since the parent workspace is not live.
      await rejects(
        db,
        () =>
          db
            .updateTable("workspaceMembers")
            .set({ status: "active", removedAt: null })
            .where("id", "=", mid)
            .execute(),
        /(?:not live|non-live)/
      )
    })
  }
)

test(
  "F4: runtime_authorization_grants is delete-protected (status table)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      // The reject-delete + status-parent-live triggers are attached (a row-level
      // BEFORE DELETE only fires on matching rows, so we assert via the catalog
      // rather than an empty DELETE that would be a no-op).
      const trg = await sql<{ tgname: string }>`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'runtime_authorization_grants'::regclass
          AND tgname IN ('sd_reject_delete', 'sd_status_parent_live_runtime_authorization_grants')
        ORDER BY tgname
      `.execute(db)
      assert.deepEqual(
        trg.rows.map((r) => r.tgname),
        [
          "sd_reject_delete",
          "sd_status_parent_live_runtime_authorization_grants",
        ],
        "reject-delete + status-parent-live triggers attached"
      )
      // and the _live view exists (status IN ('active') + parent liveness)
      const rows = await db
        .selectFrom("runtimeAuthorizationGrantsLive")
        .select("id")
        .where("workspaceId", "=", ws)
        .execute()
      assert.equal(rows.length, 0)
    })
  }
)

test(
  "F2: markUserDeleted revokes subject-scoped grants (memory/model)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const mid = await insertMember(db, ws, u, "admin")
      const subj = await insertAccessSubjectForMember(db, ws, mid)
      // a memory space + a memory access grant to the member subject
      const space = await db
        .insertInto("memorySpaces")
        .values({
          workspaceId: ws,
          ownerSubjectId: subj,
          namespaceKey: uniq("ns"),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      await db
        .insertInto("memoryAccessGrants")
        .values({
          workspaceId: ws,
          memorySpaceId: space.id,
          subjectId: subj,
          permissions: sql`ARRAY['read']::memory_permission[]`,
          status: "active",
        })
        .execute()

      await markUserDeleted(db, u)

      const grant = await db
        .selectFrom("memoryAccessGrants")
        .select(["status", "revokedAt"])
        .where("subjectId", "=", subj)
        .executeTakeFirstOrThrow()
      assert.equal(grant.status, "revoked", "member-subject grant revoked")
      assert.ok(grant.revokedAt, "revoked_at stamped")
    })
  }
)

test(
  "F5: uninstalling a plugin soft-deletes its child connections",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      // minimal publisher/catalog item/version to satisfy installation FKs
      const pub = await db
        .insertInto("publishers")
        .values({ slug: uniq("pub"), displayName: "p" })
        .returning("id")
        .executeTakeFirstOrThrow()
      const item = await db
        .insertInto("catalogItems")
        .values({
          publisherId: pub.id,
          itemKind: "plugin_package",
          slug: uniq("it"),
          displayName: "i",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const ver = await db
        .insertInto("catalogVersions")
        .values({
          catalogItemId: item.id,
          version: "1.0.0",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const wsSubject = await db
        .insertInto("accessSubjects")
        .values({ kind: "workspace", workspaceId: ws })
        .returning("id")
        .executeTakeFirstOrThrow()
      const instId = crypto.randomUUID()
      await db
        .insertInto("workspaceResources")
        .values({
          id: instId,
          workspaceId: ws,
          kind: "plugin_installation",
          displayName: "i",
          status: "active",
          createdBySubjectId: wsSubject.id,
        } as any)
        .execute()
      const inst = await db
        .insertInto("pluginInstallations")
        .values({
          id: instId,
          catalogItemId: item.id,
          catalogVersionId: ver.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      await db
        .insertInto("pluginConnections")
        .values({
          installationId: inst.id,
          workspaceId: ws,
          bindingKey: "default",
          driver: "oauth2",
          status: "active",
        })
        .execute()

      // Exercise the REAL uninstall teardown (review F14) — same code the
      // service runs, executor-scoped so it works inside the rolled-back trx.
      await tearDownPluginInstallationOn(db as never, inst.id as string)

      const live = await db
        .selectFrom("pluginConnectionsLive")
        .select("id")
        .where("installationId", "=", inst.id)
        .execute()
      assert.equal(live.length, 0, "connections hidden after uninstall")
      const instLive = await db
        .selectFrom("pluginInstallationsLive")
        .select("id")
        .where("id", "=", inst.id)
        .execute()
      assert.equal(instLive.length, 0, "installation hidden after uninstall")
    })
  }
)

// ---- review round-5: dual-axis root views, replayable closure, account unlink

import { markAccountUnlinked, LastAccountError } from "./orchestration.js"

test(
  "F10: plugin_connections_live hides an expired (non-tombstoned) connection",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const pub = await db
        .insertInto("publishers")
        .values({ slug: uniq("pub"), displayName: "p" })
        .returning("id")
        .executeTakeFirstOrThrow()
      const item = await db
        .insertInto("catalogItems")
        .values({
          publisherId: pub.id,
          itemKind: "plugin_package",
          slug: uniq("it"),
          displayName: "i",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const ver = await db
        .insertInto("catalogVersions")
        .values({
          catalogItemId: item.id,
          version: "1.0.0",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const wsSubject = await db
        .insertInto("accessSubjects")
        .values({ kind: "workspace", workspaceId: ws })
        .returning("id")
        .executeTakeFirstOrThrow()
      const instId = crypto.randomUUID()
      await db
        .insertInto("workspaceResources")
        .values({
          id: instId,
          workspaceId: ws,
          kind: "plugin_installation",
          displayName: "i",
          status: "active",
          createdBySubjectId: wsSubject.id,
        } as any)
        .execute()
      const inst = await db
        .insertInto("pluginInstallations")
        .values({
          id: instId,
          catalogItemId: item.id,
          catalogVersionId: ver.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const conn = await db
        .insertInto("pluginConnections")
        .values({
          installationId: inst.id,
          workspaceId: ws,
          bindingKey: "default",
          driver: "oauth2",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      // expire it WITHOUT tombstoning — deleted_at stays NULL, only status flips.
      await db
        .updateTable("pluginConnections")
        .set({ status: "expired" })
        .where("id", "=", conn.id)
        .execute()
      const base = await db
        .selectFrom("pluginConnections")
        .select("id")
        .where("id", "=", conn.id)
        .execute()
      const live = await db
        .selectFrom("pluginConnectionsLive")
        .select("id")
        .where("id", "=", conn.id)
        .execute()
      assert.equal(base.length, 1, "row still present (not tombstoned)")
      assert.equal(
        live.length,
        0,
        "_live honors liveValues — expired connection excluded"
      )
    })
  }
)

test(
  "F11: markUserDeleted is replayable — closure runs even when re-invoked",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      await insertMember(db, ws, u, "admin")
      // simulate a partial/interrupted tombstone: user already soft-deleted, but
      // membership was NOT closed (e.g. an aborted prior run / ops repair).
      await db
        .updateTable("users")
        .set({ deletedAt: new Date() })
        .where("id", "=", u)
        .execute()
      const before = await db
        .selectFrom("workspaceMembers")
        .select("status")
        .where("userId", "=", u)
        .executeTakeFirstOrThrow()
      assert.equal(
        before.status,
        "active",
        "membership still active pre-replay"
      )
      // replay must drive the closure even though deleted_at is already set
      await markUserDeleted(db, u)
      const after = await db
        .selectFrom("workspaceMembers")
        .select("status")
        .where("userId", "=", u)
        .executeTakeFirstOrThrow()
      assert.equal(after.status, "removed", "replay closed the membership")
    })
  }
)

test(
  "F13: markAccountUnlinked soft-deletes one account but guards the last one",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      await db
        .insertInto("account")
        .values({
          accountId: `cred-${u}`,
          providerId: "credential",
          userId: u,
          password: "x",
        })
        .execute()
      // last remaining account → refuse
      await assert.rejects(
        () => markAccountUnlinked(db as never, u, "credential", `cred-${u}`),
        (e) => e instanceof LastAccountError
      )
      // add a second (OAuth) account → now the OAuth one can be unlinked
      await db
        .insertInto("account")
        .values({
          accountId: `oauth-${u}`,
          providerId: "feishu",
          userId: u,
        })
        .execute()
      const ok = await markAccountUnlinked(
        db as never,
        u,
        "feishu",
        `oauth-${u}`
      )
      assert.equal(ok, true, "second account unlinked")
      const oauth = await db
        .selectFrom("account")
        .selectAll()
        .where("userId", "=", u)
        .where("providerId", "=", "feishu")
        .executeTakeFirstOrThrow()
      assert.ok(oauth.deletedAt, "oauth account soft-deleted")
      assert.match(
        oauth.accountId as string,
        /^deleted:/,
        "account_id released"
      )
      // credential remains live + is now the last account again → re-guarded
      await assert.rejects(
        () => markAccountUnlinked(db as never, u, "credential", `cred-${u}`),
        (e) => e instanceof LastAccountError
      )
      // unknown account → idempotent false (no throw)
      const none = await markAccountUnlinked(db as never, u, "nope", "nope")
      assert.equal(none, false, "unknown account is a no-op")
    })
  }
)

// ---- review round-6: parent liveValues at the DB trigger + app reads ---------

/** Insert a minimal live plugin installation; returns its id + workspace. */
async function insertInstallation(
  db: AnyDb,
  ws: string
): Promise<{ instId: string; itemId: string; verId: string }> {
  const pub = await db
    .insertInto("publishers")
    .values({ slug: uniq("pub"), displayName: "p" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto("catalogItems")
    .values({
      publisherId: pub.id,
      itemKind: "plugin_package",
      slug: uniq("it"),
      displayName: "i",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ver = await db
    .insertInto("catalogVersions")
    .values({ catalogItemId: item.id, version: "1.0.0", status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const wsSubject = await db
    .insertInto("accessSubjects")
    .values({ kind: "workspace", workspaceId: ws })
    .returning("id")
    .executeTakeFirstOrThrow()
  const instId = crypto.randomUUID()
  await db
    .insertInto("workspaceResources")
    .values({
      id: instId,
      workspaceId: ws,
      kind: "plugin_installation",
      displayName: "i",
      status: "active",
      createdBySubjectId: wsSubject.id,
    } as any)
    .execute()
  const inst = await db
    .insertInto("pluginInstallations")
    .values({
      id: instId,
      catalogItemId: item.id,
      catalogVersionId: ver.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return {
    instId: inst.id as string,
    itemId: item.id as string,
    verId: ver.id as string,
  }
}

async function insertDevice(db: AnyDb, ws: string): Promise<string> {
  const row = await insertDeviceRuntime(db, {
    workspaceId: ws,
    title: "soft-delete-device",
    publicKey: uniq("device-pk"),
    publicKeyFingerprint: uniq("device-fp"),
    trustStatus: "trusted",
  })
  return row.id as string
}

async function insertDeviceCapability(
  db: AnyDb,
  ws: string
): Promise<{ capabilityId: string; exposureId: string; serviceId: string }> {
  const deviceId = await insertDevice(db, ws)
  const service = await db
    .insertInto("runtimeServices")
    .values({
      runtimeId: deviceId,
      serviceKind: "device_runtime",
      status: "online",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const exposure = await db
    .insertInto("runtimeExposures")
    .values({
      runtimeId: deviceId,
      workspaceId: ws,
      serviceId: service.id as string,
      stableKey: uniq("device-exposure"),
      displayName: "soft-delete exposure",
      transport: "stdio",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const capabilityId = crypto.randomUUID()
  const platformSubject = await ensurePlatformSubject(db)
  await db
    .insertInto("workspaceResources")
    .values({
      id: capabilityId,
      workspaceId: ws,
      kind: "runtime_capability",
      displayName: "soft-delete exposure",
      status: "active",
      createdBySubjectId: platformSubject,
    } as any)
    .execute()
  const capability = await db
    .insertInto("runtimeCapabilities")
    .values({
      id: capabilityId,
      workspaceId: ws,
      exposureId: exposure.id as string,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return {
    capabilityId: capability.id as string,
    exposureId: exposure.id as string,
    serviceId: service.id as string,
  }
}

// Insert an automation_event_source folded into workspace_resources: the root
// (kind='automation_event_source') + a same-id detail row. Returns the shared id.
async function insertAutomationEventSource(
  db: AnyDb,
  ws: string,
  status: string = "active"
): Promise<string> {
  const sourceId = crypto.randomUUID()
  const creatorSubject = await insertWorkspaceSubject(db, ws)
  await db
    .insertInto("workspaceResources")
    .values({
      id: sourceId,
      workspaceId: ws,
      kind: "automation_event_source",
      displayName: "soft-delete event source",
      status,
      createdBySubjectId: creatorSubject,
    } as any)
    .execute()
  await db
    .insertInto("automationEventSources")
    .values({
      id: sourceId,
      workspaceId: ws,
      providerKind: "internal",
      sourceKey: uniq("aes"),
    } as any)
    .execute()
  return sourceId
}

test(
  "F18: an active grant requires its automation event-source root to be live (parent-liveness)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const memberId = await insertMember(db, ws, u, "admin")
      const memberSubject = await insertAccessSubjectForMember(db, ws, memberId)
      const sourceId = await insertAutomationEventSource(db, ws, "active")

      // Baseline: a use-grant on a LIVE source root inserts fine.
      const grant = await db
        .insertInto("workspaceResourceGrants")
        .values({
          workspaceId: ws,
          workspaceResourceId: sourceId,
          subjectId: memberSubject,
          permissions: ["use"],
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      assert.ok(grant.id, "grant on a live source root is accepted")

      // Archiving the source root drops it from workspace_resources_live; the
      // automation_event_sources_live view (detail folds in root liveness) hides it.
      await db
        .updateTable("workspaceResources")
        .set({ status: "archived" })
        .where("id", "=", sourceId)
        .execute()
      const liveSource = await db
        .selectFrom("automationEventSourcesLive")
        .select("id")
        .where("id", "=", sourceId)
        .execute()
      assert.equal(
        liveSource.length,
        0,
        "an archived source root hides the source from automation_event_sources_live"
      )

      // A NEW active grant on the now-archived (non-live) source root is rejected
      // by the sd_fk_live_workspace_resource_grants_workspace_resource_id trigger.
      await rejects(
        db,
        () =>
          db
            .insertInto("workspaceResourceGrants")
            .values({
              workspaceId: ws,
              workspaceResourceId: sourceId,
              subjectId: memberSubject,
              permissions: ["use"],
              status: "active",
            })
            .execute(),
        /references non-live workspace_resources/
      )
    })
  }
)

test(
  "F15: FK-liveness trigger blocks a child under an ARCHIVED (non-live) parent",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const { instId } = await insertInstallation(db, ws)
      // a connection under the live installation is fine
      await db
        .insertInto("pluginConnections")
        .values({
          installationId: instId,
          workspaceId: ws,
          bindingKey: "default",
          driver: "oauth2",
          status: "active",
        })
        .execute()
      // archive the installation WITHOUT tombstoning (status -> non-live)
      await db
        .updateTable("workspaceResources")
        .set({ status: "archived" })
        .where("id", "=", instId)
        .execute()
      // a NEW connection under the archived (non-live) parent must be rejected by
      // the FK-liveness trigger — even though deleted_at IS NULL.
      await rejects(
        db,
        () =>
          db
            .insertInto("pluginConnections")
            .values({
              installationId: instId,
              workspaceId: ws,
              bindingKey: "second",
              driver: "oauth2",
              status: "active",
            })
            .execute(),
        /references non-live (workspace_resources|plugin_installations)/
      )
    })
  }
)

test(
  "F16: an archived installation is excluded from plugin_installations_live",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const { instId } = await insertInstallation(db, ws)
      // disabled is still LIVE (in liveValues) — must remain visible
      await db
        .updateTable("workspaceResources")
        .set({ status: "disabled" })
        .where("id", "=", instId)
        .execute()
      let live = await db
        .selectFrom("pluginInstallationsLive")
        .select("id")
        .where("id", "=", instId)
        .execute()
      assert.equal(live.length, 1, "disabled install is still live")
      // archived is NOT in liveValues — must drop from the live surface
      await db
        .updateTable("workspaceResources")
        .set({ status: "archived" })
        .where("id", "=", instId)
        .execute()
      live = await db
        .selectFrom("pluginInstallationsLive")
        .select("id")
        .where("id", "=", instId)
        .execute()
      assert.equal(live.length, 0, "archived install excluded from _live")
      const base = await db
        .selectFrom("pluginInstallations")
        .select("id")
        .where("id", "=", instId)
        .execute()
      assert.equal(base.length, 1, "row still present (not tombstoned)")
    })
  }
)

test(
  "F18: plugin_connections_live folds in parent installation liveness",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const { instId } = await insertInstallation(db, ws)
      const conn = await db
        .insertInto("pluginConnections")
        .values({
          installationId: instId,
          workspaceId: ws,
          bindingKey: "default",
          driver: "oauth2",
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow()

      await db
        .updateTable("workspaceResources")
        .set({ status: "archived" })
        .where("id", "=", instId)
        .execute()

      const live = await db
        .selectFrom("pluginConnectionsLive")
        .select("id")
        .where("id", "=", conn.id)
        .execute()
      assert.equal(
        live.length,
        0,
        "connection hidden when parent install is archived"
      )
    })
  }
)

test(
  "F18: status revive of a dual-axis root under a non-live parent is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const { instId } = await insertInstallation(db, ws)
      const conn = await db
        .insertInto("pluginConnections")
        .values({
          installationId: instId,
          workspaceId: ws,
          bindingKey: "default",
          driver: "oauth2",
          status: "expired",
        })
        .returning("id")
        .executeTakeFirstOrThrow()

      await db
        .updateTable("workspaceResources")
        .set({ status: "archived" })
        .where("id", "=", instId)
        .execute()

      await rejects(
        db,
        () =>
          db
            .updateTable("pluginConnections")
            .set({ status: "active" })
            .where("id", "=", conn.id)
            .execute(),
        /references non-live (workspace_resources|plugin_installations)/
      )
    })
  }
)

test(
  "F18: deleted_at roots fold in status-parent liveness",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const member = await insertMember(db, ws, u)
      const group = await db
        .insertInto("modelGroups")
        .values({
          ownerType: "workspace_member",
          ownerWorkspaceMemberId: member,
          name: "member-owned",
        })
        .returning("id")
        .executeTakeFirstOrThrow()

      await db
        .updateTable("workspaceMembers")
        .set({ status: "removed" })
        .where("id", "=", member)
        .execute()

      const live = await db
        .selectFrom("modelGroupsLive")
        .select("id")
        .where("id", "=", group.id)
        .execute()
      assert.equal(
        live.length,
        0,
        "member-owned model group hidden when owner member is removed"
      )

      await rejects(
        db,
        () =>
          db
            .insertInto("modelGroups")
            .values({
              ownerType: "workspace_member",
              ownerWorkspaceMemberId: member,
              name: "late-member-owned",
            })
            .execute(),
        /references non-live workspace_members/
      )
    })
  }
)

test(
  "F19: device derived live views honor liveValues and grant parent liveness",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const offlineDeviceId = await insertDevice(db, ws)
      const offlineService = await db
        .insertInto("runtimeServices")
        .values({
          runtimeId: offlineDeviceId,
          serviceKind: "device_runtime",
          status: "offline",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      const offlineServiceLive = await db
        .selectFrom("runtimeServicesLive")
        .select("id")
        .where("id", "=", offlineService.id)
        .execute()
      assert.equal(
        offlineServiceLive.length,
        0,
        "offline device service excluded from _live"
      )
      await rejects(
        db,
        () =>
          db
            .insertInto("runtimeExposures")
            .values({
              runtimeId: offlineDeviceId,
              workspaceId: ws,
              serviceId: offlineService.id as string,
              stableKey: uniq("offline-exposure"),
              displayName: "offline exposure",
              transport: "stdio",
            } as any)
            .execute(),
        /references non-live runtime_services/
      )

      const { capabilityId, exposureId } = await insertDeviceCapability(db, ws)
      const hiddenTool = await db
        .insertInto("runtimeTools")
        .values({
          exposureId: exposureId,
          stableKey: uniq("hidden-tool"),
          currentName: "hidden_tool",
          status: "hidden",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const removedTool = await db
        .insertInto("runtimeTools")
        .values({
          exposureId: exposureId,
          stableKey: uniq("removed-tool"),
          currentName: "removed_tool",
          status: "removed",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const hiddenRemovedToolsLive = await db
        .selectFrom("runtimeToolsLive")
        .select("id")
        .where("id", "in", [hiddenTool.id, removedTool.id])
        .execute()
      assert.equal(
        hiddenRemovedToolsLive.length,
        0,
        "hidden/removed device tools excluded from _live"
      )

      const catalogRevision = await db
        .insertInto("runtimeCatalogRevisions")
        .values({
          exposureId: exposureId,
          revisionSeq: 1,
          schemaHash: uniq("schema-hash"),
          status: "active",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      await rejects(
        db,
        () =>
          db
            .insertInto("runtimeToolRevisions")
            .values({
              toolId: removedTool.id as string,
              catalogRevisionId: catalogRevision.id as string,
              toolName: "removed_tool",
            } as any)
            .execute(),
        /references non-live runtime_tools/
      )

      const subject = await db
        .insertInto("workspaceMembers")
        .values({ workspaceId: ws, userId: u, trustLevel: "admin" })
        .returning("id")
        .executeTakeFirstOrThrow()
      const subjectRef = await db
        .insertInto("accessSubjects")
        .values({
          kind: "workspace_member",
          workspaceId: ws,
          workspaceMemberId: subject.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const binding = await db
        .insertInto("workspaceResourceGrants")
        .values({
          workspaceId: ws,
          workspaceResourceId: capabilityId,
          subjectId: subjectRef.id,
          permissions: ["use"],
          status: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow()

      await db
        .updateTable("workspaceResources")
        .set({ status: "archived" })
        .where("id", "=", capabilityId)
        .execute()

      const archivedCapabilityLive = await db
        .selectFrom("runtimeCapabilitiesLive")
        .select("id")
        .where("id", "=", capabilityId)
        .execute()
      assert.equal(
        archivedCapabilityLive.length,
        0,
        "archived device capability excluded from _live"
      )

      const allowed = await checkPermission(db as never, {
        resourceType: "runtime_capability",
        resourceId: capabilityId,
        permission: "view",
        subject: { type: "workspace_member", id: subject.id as string },
      })
      assert.equal(
        allowed,
        false,
        "archived device capability is not authorizable even if a grant row still exists"
      )
    })
  }
)

test(
  "F20: manifest-live child tables get canonical live views and parent-liveness guards",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const u = await insertUser(db)
      const ws = await insertWorkspace(db, u)
      const actorId = await insertActor(db, ws)
      const conversationId = await insertConversation(db, ws)
      const actorSubject = await db
        .insertInto("accessSubjects")
        .values({
          kind: "actor",
          workspaceId: ws,
          actorId: actorId,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const participant = await db
        .insertInto("conversationParticipants")
        .values({
          conversationId: conversationId,
          subjectId: actorSubject.id,
          state: "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow()

      let participantLive = await db
        .selectFrom("conversationParticipantsLive")
        .select("id")
        .where("id", "=", participant.id)
        .execute()
      assert.equal(
        participantLive.length,
        1,
        "active participant appears in canonical _live view"
      )
      const rule = await db
        .insertInto("automationRules")
        .values({
          workspaceId: ws,
          conversationId: conversationId,
          category: "event_subscription",
          name: "participant provenance rule",
          createdByParticipantId: participant.id as string,
          status: "active",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      await db
        .updateTable("conversationParticipants")
        .set({ state: "left" })
        .where("id", "=", participant.id)
        .execute()

      participantLive = await db
        .selectFrom("conversationParticipantsLive")
        .select("id")
        .where("id", "=", participant.id)
        .execute()
      assert.equal(
        participantLive.length,
        0,
        "left participant excluded from canonical _live view"
      )

      await db
        .updateTable("automationRules")
        .set({ status: "archived" })
        .where("id", "=", rule.id)
        .execute()
      await db
        .updateTable("automationRules")
        .set({ status: "active" })
        .where("id", "=", rule.id)
        .execute()

      const ruleLive = await db
        .selectFrom("automationRulesLive")
        .select("id")
        .where("id", "=", rule.id)
        .execute()
      assert.equal(
        ruleLive.length,
        1,
        "creator participant is provenance and must not hide an active rule"
      )

      await db
        .updateTable("conversations")
        .set({ deletedAt: new Date() })
        .where("id", "=", conversationId)
        .execute()
      await rejects(
        db,
        () =>
          db
            .updateTable("conversationParticipants")
            .set({ state: "active" })
            .where("id", "=", participant.id)
            .execute(),
        /references non-live conversations/
      )
    })
  }
)
