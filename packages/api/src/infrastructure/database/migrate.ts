import { query } from "./index.js";
import { readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);

export async function resetDatabaseSchema() {
  console.log("Resetting database schema...");

  await query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;
    GRANT ALL ON SCHEMA public TO public;
  `);

  const sql = readFileSync(join(__dirname, "schema.sql"), "utf-8");

  try {
    await query(sql);
    console.log("Database reset and schema creation completed successfully");
  } catch (error) {
    console.error("Database reset failed:", error);
    throw error;
  }
}

async function main() {
  await resetDatabaseSchema();
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error("Database reset failed:", error);
    process.exit(1);
  });
}
