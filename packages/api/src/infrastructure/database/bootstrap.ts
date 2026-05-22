import { readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import { executeSql } from "./kysely.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const __filename = fileURLToPath(import.meta.url)
const schemaSql = readFileSync(join(__dirname, "schema.sql"), "utf-8")

const CURRENT_SCHEMA_VERSION = "2026-05-22-s9"
const CURRENT_SCHEMA_DESCRIPTION =
  "rename conversation_participants.participant_kind -> participant_type and ENUM type to match"

/**
 * Incremental DDL applied to non-empty existing databases. Each step is
 * idempotent (guards via IF NOT EXISTS or PL/pgSQL existence checks) so it
 * can be re-run safely.
 *
 * For a fresh DB the full schema.sql is applied once and every version below
 * is recorded as already-applied (since the DDL is folded in).
 */
interface IncrementalMigration {
  version: string
  description: string
  sql: string
}

const INCREMENTAL_MIGRATIONS: IncrementalMigration[] = [
  {
    version: "2026-05-22-s7",
    description:
      "add chat_push_tokens for S7 push notification token registration",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_push_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_member_id UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
        platform TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
        token TEXT NOT NULL,
        device_label TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (workspace_member_id, token)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_push_tokens_workspace_member
        ON chat_push_tokens(workspace_member_id);
    `,
  },
  {
    version: "2026-05-22-s9",
    description:
      "rename conversation_participants.participant_kind -> participant_type and matching ENUM type",
    sql: `
      DO $$
      BEGIN
        -- Rename column conversation_participants.participant_kind -> participant_type if still old.
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'conversation_participants'
            AND column_name = 'participant_kind'
        ) THEN
          ALTER TABLE conversation_participants RENAME COLUMN participant_kind TO participant_type;
        END IF;

        -- Rename ENUM type conversation_participants_kind -> conversation_participants_type if still old.
        IF EXISTS (
          SELECT 1
          FROM pg_type
          WHERE typname = 'conversation_participants_kind'
        ) THEN
          ALTER TYPE conversation_participants_kind RENAME TO conversation_participants_type;
        END IF;
      END
      $$;
    `,
  },
]

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

async function loadAppliedSchemaVersions() {
  const result = await executeSql<{ version: string }>(
    `SELECT version FROM schema_migrations`
  )
  return new Set(result.rows.map((row) => row.version))
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

async function recordSchemaVersion(version: string, description: string) {
  await executeSql(
    `INSERT INTO schema_migrations (version, description)
     VALUES ($1, $2)
     ON CONFLICT (version) DO NOTHING`,
    [version, description]
  )
}

async function recordCurrentSchemaVersion() {
  await recordSchemaVersion(CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_DESCRIPTION)
}

async function recordAllKnownMigrationsAsApplied() {
  for (const migration of INCREMENTAL_MIGRATIONS) {
    await recordSchemaVersion(migration.version, migration.description)
  }
  await recordCurrentSchemaVersion()
}

async function applyIncrementalMigrations() {
  const applied = await loadAppliedSchemaVersions()
  let appliedAny = false
  for (const migration of INCREMENTAL_MIGRATIONS) {
    if (applied.has(migration.version)) continue
    console.log(
      `[migrate] Applying ${migration.version}: ${migration.description}`
    )
    await executeSql(migration.sql)
    await recordSchemaVersion(migration.version, migration.description)
    appliedAny = true
  }
  return appliedAny
}

async function applyBootstrapSchema() {
  await executeSql(schemaSql)
}

export async function bootstrapDatabaseSchema() {
  console.log("Checking database schema bootstrap state...")

  await ensureSchemaMigrationsTable()
  const tableCount = await countBusinessTables()

  // Fresh DB: apply the full bootstrap schema and mark every known migration
  // as applied (since the DDL is folded into schema.sql).
  if (tableCount === 0) {
    try {
      await applyBootstrapSchema()
      console.log("Database schema bootstrap completed successfully")
      await ensureSchemaMigrationsTable()
      await recordAllKnownMigrationsAsApplied()
      return { bootstrapped: true, upgraded: false, tableCount: 0 }
    } catch (error) {
      console.error("Database bootstrap failed:", error)
      throw error
    }
  }

  // Existing DB: run any incremental migrations that haven't been applied.
  const upgraded = await applyIncrementalMigrations()
  // Defensive: record the current schema version so older deployments that
  // pre-date the incremental table get aligned.
  if (await hasCurrentSchemaVersion()) {
    console.log(
      `Database schema is already at version ${CURRENT_SCHEMA_VERSION} (${tableCount} public tables).`
    )
  } else {
    await recordCurrentSchemaVersion()
  }
  return { bootstrapped: false, upgraded, tableCount }
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
    await recordAllKnownMigrationsAsApplied()
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
