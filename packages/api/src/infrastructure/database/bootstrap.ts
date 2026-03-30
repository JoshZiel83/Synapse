import { executeSql } from "./kysely.js";
import { readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const schemaSql = readFileSync(join(__dirname, "schema.sql"), "utf-8");

async function countUserTables() {
  const result = await executeSql<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'`,
  );
  return Number.parseInt(result.rows[0]?.count || "0", 10);
}

async function applyBootstrapSchema() {
  await executeSql(schemaSql);
}

export async function bootstrapDatabaseSchema() {
  console.log("Checking database schema bootstrap state...");

  const tableCount = await countUserTables();
  if (tableCount > 0) {
    console.log(
      `Database already contains ${tableCount} public tables. Skipping schema bootstrap; db:bootstrap is non-destructive.`,
    );
    return { bootstrapped: false, tableCount };
  }

  try {
    await applyBootstrapSchema();
    console.log("Database schema bootstrap completed successfully");
    return { bootstrapped: true, tableCount: 0 };
  } catch (error) {
    console.error("Database schema bootstrap failed:", error);
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
