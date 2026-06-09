import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { sql } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { SUBJECT_KIND } from "@synapse/shared"

type AnyDb = import("kysely").Kysely<any>

// These tests exercise the P1b plugin_installations schema migration at the
// trx-scoped DB layer. The mcp-plugins/service.ts still imports the global
// db, so the full service path can't be exercised inside withTestDb — the
// schema-level assertions are what verify the subject_id pivot.

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
  const actorId = crypto.randomUUID()
  await db
    .insertInto("workspace_apps")
    .values({
      id: actorId,
      workspace_id: workspaceId,
      kind: "actor",
      display_name: "test actor",
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: "test",
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertConversation(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspace_id: workspaceId,
      title: "test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertCatalogVersion(
  db: AnyDb
): Promise<{ itemId: string; versionId: string }> {
  // Set up minimum catalog row chain a plugin install needs.
  const publisher = await db
    .insertInto("publishers")
    .values({
      slug: `pub-${Math.random().toString(36).slice(2, 8)}`,
      display_name: "test publisher",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto("catalog_items")
    .values({
      publisher_id: publisher.id as string,
      slug: `cat-${Math.random().toString(36).slice(2, 8)}`,
      item_kind: "plugin_package",
      display_name: "test plugin",
      is_active: true,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const version = await db
    .insertInto("catalog_versions")
    .values({
      catalog_item_id: item.id as string,
      version: "1.0.0",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return { itemId: item.id as string, versionId: version.id as string }
}

async function insertPluginInstallation(
  db: AnyDb,
  input: {
    workspaceId: string
    subjectId: string
    catalogItemId: string
    catalogVersionId: string
  }
): Promise<string> {
  const installationId = crypto.randomUUID()
  await db
    .insertInto("workspace_apps")
    .values({
      id: installationId,
      workspace_id: input.workspaceId,
      kind: "plugin_installation",
      display_name: "test installation",
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("plugin_installations")
    .values({
      id: installationId,
      catalog_item_id: input.catalogItemId,
      catalog_version_id: input.catalogVersionId,
      attachment_scope_subject_id: input.subjectId,
      config_data: {} as any,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "plugin_installations accepts a workspace-kind subject as attachment",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const catalog = await insertCatalogVersion(db)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const installationId = await insertPluginInstallation(db, {
        workspaceId,
        subjectId,
        catalogItemId: catalog.itemId,
        catalogVersionId: catalog.versionId,
      })
      const row = await db
        .selectFrom("plugin_installations as p")
        .innerJoin(
          "access_subjects as s",
          "s.id",
          "p.attachment_scope_subject_id"
        )
        .select(["s.kind", "s.workspace_id"])
        .where("p.id", "=", installationId)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "workspace")
      assert.equal(row.workspace_id, workspaceId)
    })
  }
)

test(
  "plugin_installations accepts each attachment subject kind (workspace_member / actor / conversation)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)
      const catalog = await insertCatalogVersion(db)

      const memberSub = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })
      const actorSub = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      const convSub = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId,
      })

      const ids = await Promise.all(
        [memberSub, actorSub, convSub].map((subjectId) =>
          insertPluginInstallation(db, {
            workspaceId,
            subjectId,
            catalogItemId: catalog.itemId,
            catalogVersionId: catalog.versionId,
          })
        )
      )

      const rows = await db
        .selectFrom("plugin_installations as p")
        .innerJoin(
          "access_subjects as s",
          "s.id",
          "p.attachment_scope_subject_id"
        )
        .select(["s.kind"])
        .where("p.id", "in", ids)
        .execute()

      const kinds = rows.map((r) => r.kind).sort()
      assert.deepEqual(kinds, ["actor", "conversation", "workspace_member"])
    })
  }
)

test(
  "soft-delete: member hard delete forbidden; access_subjects + plugin_installation preserved",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const catalog = await insertCatalogVersion(db)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })
      const installationId = await insertPluginInstallation(db, {
        workspaceId,
        subjectId,
        catalogItemId: catalog.itemId,
        catalogVersionId: catalog.versionId,
      })
      // Soft-delete world (design §0/§5/§7): there is NO DB cascade. Hard-deleting
      // the member is forbidden by sd_reject_delete; the member is status-flipped,
      // its access_subjects row is preserved (immutable registry), and the
      // plugin_installation row survives (no cascade) — it is soft-deleted by the
      // uninstall path, not removed by member deletion.
      await sql`SAVEPOINT sd_probe`.execute(db)
      await assert.rejects(
        db.deleteFrom("workspace_members").where("id", "=", memberId).execute(),
        /hard delete of workspace_members is forbidden/
      )
      await sql`ROLLBACK TO SAVEPOINT sd_probe`.execute(db)

      await db
        .updateTable("workspace_members")
        .set({ status: "removed", removed_at: new Date() })
        .where("id", "=", memberId)
        .execute()

      const subj = await db
        .selectFrom("access_subjects")
        .select("id")
        .where("id", "=", subjectId)
        .execute()
      assert.equal(subj.length, 1, "access_subjects row preserved")
      const remaining = await db
        .selectFrom("plugin_installations")
        .select("id")
        .where("id", "=", installationId)
        .execute()
      assert.equal(
        remaining.length,
        1,
        "plugin_installation preserved (no cascade)"
      )
    })
  }
)
