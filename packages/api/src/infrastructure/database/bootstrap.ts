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
export const CURRENT_SCHEMA_VERSION = "2026-05-30-external-first-class-subject"
export const CURRENT_SCHEMA_DESCRIPTION =
  "external IM identities become first-class, cross-conversation subjects: access_subjects gains transport_address_id (composite FK to transport_addresses(id, workspace_id), NO ACTION DEFERRABLE) + workspace_id, drops external_identity_key; kind='external' now workspace-rooted and deduped per transport_address (throwaway 'participant:<uuid>' subjects removed). subject_kind 'system' renamed to 'platform' (platform-scoped model-group grants). conversation_participants_type drops 'system' (participant-layer system removed; role='system' projection unaffected). New invariant triggers: tg_conversation_participant_validate (subject kind in member|actor|remote_agent|external + internal-conversation workspace match) and tg_access_subject_identity_guard (a subject's kind + identity payload are immutable while referenced by a participant). conversation_participants.participant_type column dropped (derived from joined subject kind). Prior: remove legacy A2A enum labels."

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
