import { readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import { executeSql } from "./kysely.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const __filename = fileURLToPath(import.meta.url)
const schemaSql = readFileSync(join(__dirname, "schema.sql"), "utf-8")

/**
 * `schema_migrations.version` is `VARCHAR(64)` (see
 * `ensureSchemaMigrationsTable` below). Keep the slug short — long
 * names that drift past 64 chars cause `INSERT INTO schema_migrations`
 * to error on a fresh bootstrap (`value too long for type
 * character varying(64)`). Multi-feature releases should bump this to
 * a single short slug; put narrative detail in
 * `CURRENT_SCHEMA_DESCRIPTION` instead. A unit test in
 * `bootstrap.test.ts` enforces the length invariant.
 */
export const CURRENT_SCHEMA_VERSION = "2026-05-28-im-connectors-shared-prep"
export const CURRENT_SCHEMA_DESCRIPTION =
  "IM connector shared prep: TransportConnectorCapability displayName/iconAssetPath/showsBaseUrlConfig, MessageCapabilities voice/video/interactionPrompt fields, polymorphic validateConfig/getBindingDefaults/planAccountRecoveryActions/getInteractionProjectionReadiness hooks, transactional updateTransportAccount + recovery executor, single connectors/register-all entrypoint. Schema unchanged from device-runtime-v3 cutover; this version bump documents the application-layer refactor that ships alongside."

async function ensureSchemaMigrationsTable() {
  await executeSql(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

async function countBusinessTables() {
  const result = await executeSql<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name <> 'schema_migrations'`
  )
  return Number.parseInt(result.rows[0]?.count || "0", 10)
}

async function hasCurrentSchemaVersion() {
  const result = await executeSql<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM schema_migrations
       WHERE version = $1
     ) AS exists`,
    [CURRENT_SCHEMA_VERSION]
  )
  return result.rows[0]?.exists === true
}

async function recordCurrentSchemaVersion() {
  await executeSql(
    `INSERT INTO schema_migrations (version, description)
     VALUES ($1, $2)
     ON CONFLICT (version) DO NOTHING`,
    [CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_DESCRIPTION]
  )
}

async function applyBootstrapSchema() {
  await executeSql(schemaSql)
}

/**
 * Pure function that decides what to do given the current DB state. Extracted
 * so the fail-loud rule can be unit-tested without spinning up a real Postgres
 * + writing tables.
 */
export type BootstrapDecision =
  | { kind: "noop"; reason: string }
  | { kind: "apply" }
  | { kind: "fail"; message: string }

export function decideBootstrapAction(input: {
  hasCurrentVersion: boolean
  tableCount: number
  currentVersion: string
}): BootstrapDecision {
  if (input.hasCurrentVersion) {
    return {
      kind: "noop",
      reason: `Database schema is already at version ${input.currentVersion} (${input.tableCount} public tables).`,
    }
  }
  if (input.tableCount === 0) {
    return { kind: "apply" }
  }
  return {
    kind: "fail",
    message:
      `Database already contains ${input.tableCount} public tables but is not at schema version ${input.currentVersion}. ` +
      `This release ships schema version ${input.currentVersion}, which has no in-place migration. ` +
      `Run \`npm run db:rebuild\` to drop and recreate the schema. ` +
      `If you need to preserve data, snapshot the database first and reapply business data after rebuild.`,
  }
}

export async function bootstrapDatabaseSchema() {
  console.log("Checking database schema bootstrap state...")

  await ensureSchemaMigrationsTable()

  const hasCurrentVersion = await hasCurrentSchemaVersion()
  const tableCount = await countBusinessTables()
  const decision = decideBootstrapAction({
    hasCurrentVersion,
    tableCount,
    currentVersion: CURRENT_SCHEMA_VERSION,
  })

  try {
    switch (decision.kind) {
      case "noop":
        console.log(decision.reason)
        return { bootstrapped: false, upgraded: false, tableCount }
      case "apply":
        await applyBootstrapSchema()
        console.log("Database schema bootstrap completed successfully")
        await ensureSchemaMigrationsTable()
        await recordCurrentSchemaVersion()
        return { bootstrapped: true, upgraded: false, tableCount: 0 }
      case "fail":
        // AGENTS.md: "initial design implementation phase, do not consider
        // backward-compat with existing data". Schema bumps without in-place
        // migrations require an explicit rebuild — pre-existing databases
        // must be dropped and recreated. Fail loudly instead of skipping
        // silently so the operator notices.
        throw new Error(decision.message)
    }
  } catch (error) {
    console.error("Database bootstrap/upgrade failed:", error)
    throw error
  }
}

export async function rebuildDatabaseSchema() {
  console.log("Rebuilding database schema...")

  await executeSql(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;
    GRANT ALL ON SCHEMA public TO public;
  `)

  try {
    await applyBootstrapSchema()
    await ensureSchemaMigrationsTable()
    await recordCurrentSchemaVersion()
    console.log("Database schema rebuild completed successfully")
  } catch (error) {
    console.error("Database schema rebuild failed:", error)
    throw error
  }
}

async function main() {
  await bootstrapDatabaseSchema()
  process.exit(0)
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error("Database bootstrap failed:", error)
    process.exit(1)
  })
}
