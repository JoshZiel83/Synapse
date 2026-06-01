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

export type CompiledSqlStatement = {
  sql: string
  parameters: readonly unknown[]
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
    const result = await statement.execute(executor)
    return { rows: result.rows as T[] }
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
    const result = await executor.executeQuery(builder)
    return { rows: result.rows as T[] }
  }
  return executeCompiledQuery<T>(executor, builder)
}

export async function withDbTransaction<T>(
  fn: (trx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return db.transaction().execute(fn)
}

/**
 * @deprecated Compiles a Kysely statement then runs it through the bare
 * {@link QueryExecutor}, losing end-to-end type inference (caller supplies `<T>`,
 * defaults to `any`). Use `statement.execute(executor)` / `.executeTakeFirst()`
 * on a native builder, or `sql<Row>`...`.execute(executor)` for raw SQL, so the
 * row type flows from the query. Being removed.
 */
export async function executeCompiledQuery<T = any>(
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

/**
 * @deprecated See {@link executeCompiledQuery}. Use native
 * `.executeTakeFirst()` / `sql<Row>`...`.execute(executor)` then read `rows[0]`.
 */
export async function executeTakeFirst<T = any>(
  queryable: QueryExecutor,
  statement: CompilableStatement
): Promise<T | null> {
  const result = await executeCompiledQuery<T>(queryable, statement)
  return result.rows[0] ?? null
}

/**
 * @deprecated Runs a pre-compiled SQL string through the bare
 * {@link QueryExecutor} (returns `any`). Use `sql<Row>`...`.execute(executor)`.
 */
export async function executeCompiledSql<T = any>(
  queryable: QueryExecutor,
  statement: CompiledSqlStatement
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return queryable.query(statement.sql, [
    ...statement.parameters,
  ] as any[]) as Promise<{
    rows: T[]
    rowCount?: number | null
  }>
}

/**
 * @deprecated Runs a raw SQL string against the pool (returns `any`, caller
 * supplies `<T>`). Use `sql<Row>`...`.execute(db)` so the row type flows from
 * the query. Being removed in the Kysely-convergence refactor.
 */
export async function executeSql<T = any>(
  text: string,
  parameters?: readonly unknown[]
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return executeCompiledSql<T>(pool, {
    sql: text,
    parameters: parameters ?? [],
  })
}

/**
 * @deprecated Runs a raw SQL string against a bare {@link QueryExecutor}
 * (returns `any`). Use `sql<Row>`...`.execute(executor)` with {@link Executor}.
 */
export async function executeSqlOn<T = any>(
  queryable: QueryExecutor,
  text: string,
  parameters?: readonly unknown[]
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return executeCompiledSql<T>(queryable, {
    sql: text,
    parameters: parameters ?? [],
  })
}
