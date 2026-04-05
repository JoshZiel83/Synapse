import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { executeSql } from "./kysely.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const schemaSql = readFileSync(join(__dirname, "schema.sql"), "utf-8");

const CURRENT_SCHEMA_VERSION = "2026-04-05-03";
const CURRENT_SCHEMA_DESCRIPTION =
  "enforce interaction request subtype consistency";

async function ensureSchemaMigrationsTable() {
  await executeSql(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function countBusinessTables() {
  const result = await executeSql<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name <> 'schema_migrations'`,
  );
  return Number.parseInt(result.rows[0]?.count || "0", 10);
}

async function hasCurrentSchemaVersion() {
  const result = await executeSql<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM schema_migrations
       WHERE version = $1
     ) AS exists`,
    [CURRENT_SCHEMA_VERSION],
  );
  return result.rows[0]?.exists === true;
}

async function recordCurrentSchemaVersion() {
  await executeSql(
    `INSERT INTO schema_migrations (version, description)
     VALUES ($1, $2)
     ON CONFLICT (version) DO NOTHING`,
    [CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_DESCRIPTION],
  );
}

async function applyBootstrapSchema() {
  await executeSql(schemaSql);
}

export async function bootstrapDatabaseSchema() {
  console.log("Checking database schema bootstrap state...");

  await ensureSchemaMigrationsTable();

  if (await hasCurrentSchemaVersion()) {
    const tableCount = await countBusinessTables();
    console.log(
      `Database schema is already at version ${CURRENT_SCHEMA_VERSION} (${tableCount} public tables).`,
    );
    return { bootstrapped: false, upgraded: false, tableCount };
  }

  const tableCount = await countBusinessTables();

  try {
    if (tableCount === 0) {
      await applyBootstrapSchema();
      console.log("Database schema bootstrap completed successfully");
      await ensureSchemaMigrationsTable();
      await recordCurrentSchemaVersion();
      return { bootstrapped: true, upgraded: false, tableCount: 0 };
    }

    console.log(
      `Database already contains ${tableCount} public tables. Skipping schema bootstrap; rebuild the database to apply the current schema.`,
    );
    return { bootstrapped: false, upgraded: false, tableCount };
  } catch (error) {
    console.error("Database bootstrap/upgrade failed:", error);
    throw error;
  }
}

export async function rebuildDatabaseSchema() {
  console.log("Rebuilding database schema...");

  await executeSql(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;
    GRANT ALL ON SCHEMA public TO public;
  `);

  try {
    await applyBootstrapSchema();
    await ensureSchemaMigrationsTable();
    await recordCurrentSchemaVersion();
    console.log("Database schema rebuild completed successfully");
  } catch (error) {
    console.error("Database schema rebuild failed:", error);
    throw error;
  }
}

async function main() {
  await bootstrapDatabaseSchema();
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error("Database bootstrap failed:", error);
    process.exit(1);
  });
}
