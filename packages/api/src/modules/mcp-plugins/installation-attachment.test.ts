import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { SUBJECT_KIND } from "@synapse/shared"

type AnyDb = import("kysely").Kysely<any>

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

async function insertCatalogVersion(
  db: AnyDb
): Promise<{ itemId: string; versionId: string }> {
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
    attachmentScopeSubjectId?: string | null
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
      attachment_scope_subject_id: input.attachmentScopeSubjectId ?? null,
      config_data: {} as any,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "plugin_installations allow a null attachment scope subject",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const catalog = await insertCatalogVersion(db)
      const installationId = await insertPluginInstallation(db, {
        workspaceId,
        attachmentScopeSubjectId: null,
        catalogItemId: catalog.itemId,
        catalogVersionId: catalog.versionId,
      })

      const row = await db
        .selectFrom("plugin_installations")
        .select(["id", "attachment_scope_subject_id"])
        .where("id", "=", installationId)
        .executeTakeFirstOrThrow()

      assert.equal(row.id, installationId)
      assert.equal(row.attachment_scope_subject_id, null)
    })
  }
)

test(
  "plugin_installations still accept an explicit attachment subject when present",
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
        attachmentScopeSubjectId: subjectId,
        catalogItemId: catalog.itemId,
        catalogVersionId: catalog.versionId,
      })

      const row = await db
        .selectFrom("plugin_installations as p")
        .leftJoin(
          "access_subjects as s",
          "s.id",
          "p.attachment_scope_subject_id"
        )
        .select(["p.id", "s.kind", "s.workspace_id"])
        .where("p.id", "=", installationId)
        .executeTakeFirstOrThrow()

      assert.equal(row.id, installationId)
      assert.equal(row.kind, SUBJECT_KIND.WORKSPACE)
      assert.equal(row.workspace_id, workspaceId)
    })
  }
)
