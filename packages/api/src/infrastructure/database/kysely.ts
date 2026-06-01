import { Kysely, PostgresDialect } from "kysely"
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
  })
}

export const db: KyselyDb = createDb(pool)

export type TableRow<T extends keyof Database> = Selectable<Database[T]>
export type TableInsert<T extends keyof Database> = Insertable<Database[T]>
export type TableUpdate<T extends keyof Database> = Updateable<Database[T]>
/**
 * @deprecated Legacy bare query interface (`{ query(text, params) }`). Being
 * removed in the Kysely-convergence refactor — use {@link Executor} (i.e.
 * `Kysely<Database>`: the top-level `db` or a transaction `trx`) instead, and
 * build queries from it. Do not introduce new usages.
 */
export type QueryExecutor = {
  query: (
    text: string,
    params?: any[]
  ) => Promise<{ rows: any[]; rowCount?: number | null }>
}

type CompilableStatement = {
  compile(): {
    sql: string
    parameters: readonly unknown[]
  }
}

/**
 * Transitional union accepted by access-layer `*On` helpers while the
 * Kysely-convergence refactor is in flight. New code should pass an
 * {@link Executor} (the top-level `db` or a transaction `trx`); legacy callers
 * still in `transaction(client => ...)` blocks pass a bare {@link QueryExecutor}.
 * Removed once every caller is on {@link Executor}.
 */
export type AnyExecutor = Executor | QueryExecutor

/** True when the value is a Kysely executor (db or Transaction), not a bare pg client. */
export function isKyselyExecutor(value: AnyExecutor): value is Executor {
  return typeof (value as Executor).selectFrom === "function"
}

/**
 * Narrow an {@link AnyExecutor} to a Kysely {@link Executor}. Post-convergence
 * every caller threads a Kysely executor; a bare pg client here is a bug.
 */
export function asExecutor(value: AnyExecutor): Executor {
  if (!isKyselyExecutor(value)) {
    throw new Error(
      "asExecutor: expected a Kysely executor (db/trx), got a bare pg client"
    )
  }
  return value
}

/**
 * Map a Kysely {@link QueryResult} to the `{ rows, rowCount }` shape the
 * AnyExecutor bridges expose. Kysely surfaces the affected-row count for
 * insert/update/delete as `numAffectedRows` (a bigint) and leaves it undefined
 * for selects; normalize it to `number | null` so consumers that check
 * `result.rowCount` behave identically on the Kysely and bare-pg paths.
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
 * Run a Kysely-built statement on either an {@link Executor} (native path) or a
 * bare {@link QueryExecutor} (compile → raw query). Transitional bridge for the
 * access-layer `*On` helpers; prefer `executor.executeQuery(builder)` directly
 * in fully-migrated code.
 */
export async function runCompilable<T = any>(
  executor: AnyExecutor,
  statement: import("kysely").RawBuilder<T>
): Promise<{ rows: T[]; rowCount?: number | null }> {
  if (isKyselyExecutor(executor)) {
    return toBridgeResult<T>(await statement.execute(executor))
  }
  // Compilation is executor-agnostic — produce SQL+params with the global db
  // then run on the bare pg client.
  const compiled = statement.compile(db)
  return executor.query(compiled.sql, [
    ...compiled.parameters,
  ] as any[]) as Promise<{
    rows: T[]
    rowCount?: number | null
  }>
}

/**
 * Run a Kysely query *builder* (insert/select/update/delete) on either an
 * {@link Executor} (native) or a bare {@link QueryExecutor} (compile → raw).
 * Transitional bridge for access-layer `*On` helpers.
 */
export async function runBuilder<T = any>(
  executor: AnyExecutor,
  builder: import("kysely").Compilable<T>
): Promise<{ rows: T[]; rowCount?: number | null }> {
  if (isKyselyExecutor(executor)) {
    return toBridgeResult<T>(await executor.executeQuery(builder))
  }
  return executeCompiledQuery<T>(executor, builder)
}

/**
 * `runBuilder` returning the first row (or null). Transitional bridge replacing
 * the bare `executeTakeFirst(queryable, builder)` helper at AnyExecutor call sites.
 */
export async function takeFirstOn<T = any>(
  executor: AnyExecutor,
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

/**
 * Internal: compile a Kysely statement and run it through a bare
 * {@link QueryExecutor} (pg client). Used only by {@link runBuilder} for the
 * legacy-pg-client branch of the AnyExecutor bridge. Not exported — prefer
 * `statement.execute(executor)` / `runBuilder(executor, statement)`.
 */
async function executeCompiledQuery<T = any>(
  queryable: QueryExecutor,
  statement: CompilableStatement
): Promise<{ rows: T[]; rowCount?: number | null }> {
  const compiled = statement.compile()
  return queryable.query(compiled.sql, [
    ...compiled.parameters,
  ] as any[]) as Promise<{
    rows: T[]
    rowCount?: number | null
  }>
}
