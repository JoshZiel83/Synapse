import test from "node:test"
import assert from "node:assert/strict"
import { sql, CompiledQuery } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { runBuilder, runCompilable, takeFirstOn, db } from "./kysely.js"

// Regression: the AnyExecutor bridges (runBuilder / runCompilable) must surface
// the affected-row count on the Kysely-executor path. Kysely exposes it as
// `numAffectedRows` (a bigint) — NOT `rowCount` — so the bridges have to map it.
// Before the fix the Kysely branch returned `{ rows }` only, leaving
// `result.rowCount` undefined; callers that do `if (result.rowCount !== 1) throw`
// (interactions/service.ts update-then-verify helpers) then threw AFTER a
// successful single-row UPDATE. These tests pin the count on a real PG so the
// regression can't silently come back.

async function seedUser(database: typeof db): Promise<string> {
  const row = await database
    .insertInto("users")
    .values({
      email: `rb-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "runBuilder rowCount test",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "runBuilder surfaces rowCount=1 from numAffectedRows on a single-row UPDATE (Kysely executor)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (trx) => {
      const userId = await seedUser(trx)
      const result = await runBuilder(
        trx,
        trx
          .updateTable("users")
          .set({ name: "renamed", updated_at: sql`NOW()` })
          .where("id", "=", userId)
      )
      // The exact check interactions/service.ts performs.
      assert.equal(result.rowCount, 1)
      assert.notEqual(result.rowCount, undefined)
    })
  }
)

test(
  "runBuilder reports rowCount=0 when an UPDATE matches no rows",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (trx) => {
      const result = await runBuilder(
        trx,
        trx
          .updateTable("users")
          .set({ name: "nope" })
          .where("id", "=", "00000000-0000-0000-0000-000000000000")
      )
      assert.equal(result.rowCount, 0)
    })
  }
)

test(
  "runCompilable surfaces rowCount from numAffectedRows on a raw UPDATE (Kysely executor)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (trx) => {
      const userId = await seedUser(trx)
      const result = await runCompilable<{ id: string }>(
        trx,
        sql`UPDATE users SET name = 'raw-renamed' WHERE id = ${userId}`
      )
      assert.equal(result.rowCount, 1)
    })
  }
)

test(
  "takeFirstOn still returns the row for a RETURNING insert via the Kysely path",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (trx) => {
      const userId = await seedUser(trx)
      const row = await takeFirstOn<{ id: string }>(
        trx,
        trx.selectFrom("users").select("id").where("id", "=", userId)
      )
      assert.ok(row)
      assert.equal(row?.id, userId)
    })
  }
)

test(
  "runBuilder leaves rowCount null for a SELECT (no affected-row semantics)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (trx) => {
      const userId = await seedUser(trx)
      const result = await runBuilder<{ id: string }>(
        trx,
        trx.selectFrom("users").select("id").where("id", "=", userId)
      )
      // SELECTs carry no numAffectedRows; rows still populated.
      assert.equal(result.rowCount, null)
      assert.equal(result.rows.length, 1)
    })
  }
)
