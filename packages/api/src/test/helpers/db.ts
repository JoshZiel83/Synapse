import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { after } from "node:test"
import { fileURLToPath } from "node:url"
import pg from "pg"
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql"
import {
  createDb,
  type KyselyDb,
} from "../../infrastructure/database/kysely.js"

const { Pool } = pg

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, "../../infrastructure/database/schema.sql")

type SharedTestDb = {
  container: StartedPostgreSqlContainer
  pool: pg.Pool
  db: KyselyDb
  schemaApplied: boolean
}

let sharedPromise: Promise<SharedTestDb> | null = null

// Register the teardown hook ONCE, at module-evaluation time (before any test
// runs), so it attaches to the root suite and fires exactly once after ALL
// tests in this file's process complete.
//
// Why not `process.on("beforeExit")` (the old approach): the unit `test` script
// historically ran with `--test-force-exit`, which calls `process.exit()` —
// and `beforeExit` never fires on `process.exit()`, so that hook was dead code
// that leaked one container per test-file process.
//
// Why not register inside bootSharedTestDb(): an `after()` registered while a
// test is executing attaches to THAT test, firing after the first test rather
// than after the whole file. shutdownSharedTestDb() then nulls sharedPromise
// and a later test re-boots a second container that nothing reaps. Registering
// at the top level avoids that entirely.
after(async () => {
  const keepContainer = process.env.SYNAPSE_TEST_KEEP_CONTAINERS === "1"
  await shutdownSharedTestDb({ keepContainer })
})

async function bootSharedTestDb(): Promise<SharedTestDb> {
  const image =
    process.env.SYNAPSE_TEST_POSTGRES_IMAGE || "pgvector/pgvector:pg16"
  const container = await new PostgreSqlContainer(image)
    .withDatabase("synapse_test")
    .withUsername("synapse_test")
    .withPassword("synapse_test")
    .start()

  // The container is live from here on. Any failure building the pool or
  // applying the schema must explicitly tear it down before rethrowing — the
  // top-level `after()` only reaps whatever is stored in sharedPromise, and a
  // failed boot never gets stored.
  let pool: pg.Pool | undefined
  try {
    pool = new Pool({
      connectionString: container.getConnectionUri(),
      max: 8,
    })

    const db = createDb(pool)

    const schemaSql = readFileSync(SCHEMA_PATH, "utf-8")
    const client = await pool.connect()
    try {
      await client.query(schemaSql)
    } finally {
      client.release()
    }

    return { container, pool, db, schemaApplied: true }
  } catch (err) {
    await pool?.end().catch(() => {})
    await container.stop().catch(() => {})
    throw err
  }
}

export async function getSharedTestDb(): Promise<SharedTestDb> {
  if (!sharedPromise) {
    sharedPromise = bootSharedTestDb()
  }
  try {
    return await sharedPromise
  } catch (err) {
    // A failed boot (including `container.start()` itself rejecting) must clear
    // the memoized rejected promise so the next call can retry from scratch.
    sharedPromise = null
    throw err
  }
}

async function shutdownSharedTestDb(
  opts: { keepContainer?: boolean } = {}
): Promise<void> {
  if (!sharedPromise) return
  const shared = await sharedPromise.catch(() => null)
  sharedPromise = null
  if (!shared) return
  const { pool, container } = shared
  // Always close the pool: its idle socket is the one un-unref'd handle keeping
  // the event loop alive, so this is what lets the process exit on its own even
  // in keep-container debug mode.
  await pool.end().catch(() => {})
  if (!opts.keepContainer) {
    await container.stop().catch(() => {})
  }
}

/**
 * Run `fn` inside an outer SAVEPOINT-style transaction that is always rolled back,
 * so each test sees the schema baseline without leaking writes to peer tests.
 *
 * The fn receives a transaction handle typed as KyselyDb; queries inside it
 * use the same connection and roll back together.
 */
export async function withTestDb<T>(
  fn: (db: KyselyDb) => Promise<T>
): Promise<T> {
  const shared = await getSharedTestDb()
  const sentinel: { value?: T } = {}
  await shared.db
    .transaction()
    .execute(async (trx) => {
      const result = await fn(trx as unknown as KyselyDb)
      sentinel.value = result
      throw new RollbackSignal()
    })
    .catch((err) => {
      if (err instanceof RollbackSignal) return
      throw err
    })
  return sentinel.value as T
}

/**
 * Run `fn` with both a KyselyDb handle and a pg.PoolClient pinned to the same
 * connection, all wrapped in a BEGIN/ROLLBACK so writes don't leak. Use this
 * for testing `*On(client, ...)` helpers that take a raw QueryExecutor.
 */
export async function withTestDbAndClient<T>(
  fn: (ctx: { db: KyselyDb; client: pg.PoolClient }) => Promise<T>
): Promise<T> {
  const shared = await getSharedTestDb()
  const client = await shared.pool.connect()
  await client.query("BEGIN")
  const sentinel: { value?: T } = {}
  try {
    const reusableClient = new Proxy(client, {
      get(target, prop) {
        if (prop === "release") return () => {}
        const value = (target as any)[prop]
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const adHocPool = {
      connect: async () => reusableClient,
      end: async () => {},
    } as unknown as pg.Pool
    const db = createDb(adHocPool)
    sentinel.value = await fn({ db, client })
  } finally {
    await client.query("ROLLBACK").catch(() => {})
    client.release()
  }
  return sentinel.value as T
}

class RollbackSignal extends Error {
  constructor() {
    super("rollback")
    this.name = "RollbackSignal"
  }
}
