import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely"
import type { Insertable, Selectable, Transaction, Updateable } from "kysely"
import type pg from "pg"
import { pool } from "./index.js"
import type { Database } from "./db-types.js"

export type KyselyDb = Kysely<Database>
export type DatabaseTransaction = Transaction<Database>

/**
 * Unified query executor. Because `Transaction<DB> extends Kysely<DB>`, a single
 * `Kysely<Database>` parameter accepts both the top-level `db` and a transaction
 * `trx`. This is the convergence target that replaces the legacy bare
 * `QueryExecutor` (`{ query(text, params) }`) interface: functions that used to
 * take a `pg.PoolClient`-shaped executor should take `executor: Executor = db`
 * and build queries from it (`executor.selectFrom(...)`, `sql`...`.execute(executor)`).
 */
export type Executor = Kysely<Database>

export function createDb(pgPool: pg.Pool): KyselyDb {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: pgPool,
    }),
    // Postgres stays snake_case; the TS side is fully camelCase (codegen
    // `camelCase: true`). `maintainNestedObjectKeys: true` is MANDATORY — the
    // plugin must NOT recurse into JSONB values (signed-envelope fragments,
    // JSON-Schema keywords, provider SDK keys, opaque metadata must survive
    // verbatim). See docs/architecture-boundary-refactor-master-plan.md §3.2/§4.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  })
}

export const db: KyselyDb = createDb(pool)

/**
 * A Kysely PostgresDialect over the shared connection pool, for libraries that
 * take a dialect rather than the Kysely instance (e.g. Better Auth's adapter).
 * Exposing the dialect here keeps the bare `pool` sealed inside the database
 * layer — business modules import this instead of reaching for `pool`.
 */
export function createBetterAuthDialect(): PostgresDialect {
  return new PostgresDialect({ pool })
}

export type TableRow<T extends keyof Database> = Selectable<Database[T]>
export type TableInsert<T extends keyof Database> = Insertable<Database[T]>
export type TableUpdate<T extends keyof Database> = Updateable<Database[T]>

/**
 * Map a Kysely {@link QueryResult} to the `{ rows, rowCount }` shape the
 * `runBuilder`/`runCompilable` bridges expose. Kysely surfaces the affected-row
 * count for insert/update/delete as `numAffectedRows` (a bigint) and leaves it
 * undefined for selects; normalize it to `number | null` so consumers that
 * check `result.rowCount` (e.g. task update-then-verify helpers) behave
 * correctly.
 */
function toBridgeResult<T>(result: {
  rows: readonly T[]
  numAffectedRows?: bigint
}): { rows: T[]; rowCount: number | null } {
  return {
    rows: result.rows as T[],
    rowCount:
      result.numAffectedRows === undefined
        ? null
        : Number(result.numAffectedRows),
  }
}

/**
 * Run a raw Kysely statement (`sql` tag) on an {@link Executor} (db or trx) and
 * normalize the result to `{ rows, rowCount }`. Thin helper for access-layer
 * `*On` callers; prefer `statement.execute(executor)` directly in new code.
 */
export async function runCompilable<T = any>(
  executor: Executor,
  statement: import("kysely").RawBuilder<T>
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return toBridgeResult<T>(await statement.execute(executor))
}

/**
 * Run a Kysely query *builder* (insert/select/update/delete) on an
 * {@link Executor} (db or trx) and normalize the result to `{ rows, rowCount }`.
 * Thin helper for access-layer `*On` callers; prefer
 * `builder.execute(executor)` / `.executeTakeFirst()` directly in new code.
 */
export async function runBuilder<T = any>(
  executor: Executor,
  builder: import("kysely").Compilable<T>
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return toBridgeResult<T>(await executor.executeQuery(builder))
}

/**
 * `runBuilder` returning the first row (or null). Thin helper for access-layer
 * `*On` call sites.
 */
export async function takeFirstOn<T = any>(
  executor: Executor,
  builder: import("kysely").Compilable<T>
): Promise<T | null> {
  const result = await runBuilder<T>(executor, builder)
  return result.rows[0] ?? null
}

export async function withDbTransaction<T>(
  fn: (trx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return db.transaction().execute(fn)
}
