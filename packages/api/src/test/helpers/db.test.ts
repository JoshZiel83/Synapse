import test from "node:test"
import assert from "node:assert/strict"
import { sql } from "kysely"
import { withTestDb } from "../helpers/db.js"

test(
  "testcontainers helper boots a postgres database with schema applied",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const result = await sql<{ table_name: string }>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name IN ('workspaces', 'workspace_members', 'resource_access_bindings')
        ORDER BY table_name
      `.execute(db)

      const tableNames = result.rows.map((row) => row.table_name)
      assert.deepEqual(tableNames, [
        "resource_access_bindings",
        "workspace_members",
        "workspaces",
      ])
    })
  }
)

test(
  "withTestDb rolls back writes so each test sees the schema baseline",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      await sql`
        INSERT INTO users (email, name)
        VALUES ('rollback-probe@example.test', 'rollback probe')
      `.execute(db)

      const after = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM users WHERE email = 'rollback-probe@example.test'
      `.execute(db)
      assert.equal(after.rows[0]?.count, "1")
    })

    await withTestDb(async (db) => {
      const persisted = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM users WHERE email = 'rollback-probe@example.test'
      `.execute(db)
      assert.equal(
        persisted.rows[0]?.count,
        "0",
        "writes from the previous withTestDb invocation must not persist"
      )
    })
  }
)
