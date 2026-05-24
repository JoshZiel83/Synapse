import { Kysely, PostgresDialect } from "kysely"
import type { Insertable, Selectable, Transaction, Updateable } from "kysely"
import type pg from "pg"
import { pool } from "./index.js"
import type { Database } from "./db-types.js"

export type KyselyDb = Kysely<Database>
export type DatabaseTransaction = Transaction<Database>

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

export async function withDbTransaction<T>(
  fn: (trx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return db.transaction().execute(fn)
}

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

export async function executeTakeFirst<T = any>(
  queryable: QueryExecutor,
  statement: CompilableStatement
): Promise<T | null> {
  const result = await executeCompiledQuery<T>(queryable, statement)
  return result.rows[0] ?? null
}

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

export async function executeSql<T = any>(
  text: string,
  parameters?: readonly unknown[]
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return executeCompiledSql<T>(pool, {
    sql: text,
    parameters: parameters ?? [],
  })
}

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
