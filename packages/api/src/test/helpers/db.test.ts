import test from "node:test"
import assert from "node:assert/strict"
import { sql } from "kysely"
import { withTestDb } from "../helpers/db.js"

test(
  "testcontainers helper boots a postgres database with schema applied",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      // `resource_access_bindings` was dropped by the workspace-resource authz
      // unification (automation event-source authz folded into
      // `workspace_resource_grants`). Probe the tables that survive the fold so
      // the schema-baseline check stays meaningful without referencing a table
      // that no longer exists.
      const result = await sql<{ tableName: string }>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name IN ('workspaces', 'workspace_members', 'workspace_resource_grants')
        ORDER BY table_name
      `.execute(db)

      const tableNames = result.rows.map((row) => row.tableName)
      assert.deepEqual(tableNames, [
        "workspace_members",
        "workspace_resource_grants",
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
