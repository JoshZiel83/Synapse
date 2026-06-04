import { readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import { sql } from "kysely"
import { db } from "./kysely.js"

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
// MERGE (feat/file-service-cas-manifest <- dev): the applied schema.sql carries
// BOTH the conversation-type/derived-IM reshape (dev) AND the file-service CAS
// refactor (this branch). A single combined version slug + description records
// both so schema_migrations is not mislabeled. Slug kept <=64 chars (VARCHAR(64);
// bootstrap.test.ts enforces); full narrative lives in the (unbounded) description.
export const CURRENT_SCHEMA_VERSION = "2026-06-04-better-auth-after-mcp-sandbox"
export const CURRENT_SCHEMA_DESCRIPTION =
  "Account/auth redesign onto Better Auth (better-auth@1.6.13), merged on top of the MCP-remote-transports + server-side actor sandbox release. " +
  "(A) Account/auth: users.password_hash dropped (password now lives in account); users gains email_verified (NOT NULL default false), image (BA core avatar URL, separate from avatar_file_id), and feishu_open_id/feishu_union_id/feishu_tenant_key. New BA core tables account (provider_id+account_id unique; credential provider holds the scrypt password, OAuth providers hold encrypted tokens), session (opaque token, BA-owned), verification, and device_code (deviceAuthorization RFC 8628 cross-device QR login; user_code/device_code unique). Dropped legacy hand-rolled auth_sessions + auth_qr_login_requests tables and their enums (auth_sessions_client_type/transport, auth_qr_login_requests_status/approved_session_persistence). All BA-table ids carry DEFAULT uuid_generate_v4() because BA runs with generateId:false (omits id on INSERT). user/account/session FKs and access_subjects(kind='user') are unchanged (still reference users(id)). " +
  "(B) MCP official remote endpoints (from dev): plugin_package_version_specs_transport enum gains 'sse' (AMiner proxies the official SSE-only MCP server; AMap/Mijia use http) — a NON-migratable enum change, so pre-existing databases must be rebuilt (db:rebuild). " +
  "(C) Server-side actor sandbox (from dev): file_mounts.sandbox_backend/sandbox_resource_id + idx_file_mounts_live_backend. " +
  "(D) Prior combined release (conversation-type derived-IM + file-service CAS) carried forward unchanged from the merge base."

async function ensureSchemaMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)
}

async function countBusinessTables() {
  const result = await sql<{ count: string }>`
    SELECT COUNT(*) AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name <> 'schema_migrations'`.execute(db)
  return Number.parseInt(result.rows[0]?.count || "0", 10)
}

async function hasCurrentSchemaVersion() {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM schema_migrations
      WHERE version = ${CURRENT_SCHEMA_VERSION}
    ) AS exists`.execute(db)
  return result.rows[0]?.exists === true
}

async function recordCurrentSchemaVersion() {
  await sql`
    INSERT INTO schema_migrations (version, description)
    VALUES (${CURRENT_SCHEMA_VERSION}, ${CURRENT_SCHEMA_DESCRIPTION})
    ON CONFLICT (version) DO NOTHING`.execute(db)
}

async function applyBootstrapSchema() {
  // schemaSql is a trusted local file (schema.sql) containing the full DDL with
  // multiple statements — must run as raw SQL, not a parameterized fragment.
  await sql.raw(schemaSql).execute(db)
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

  await sql
    .raw(
      `
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;
    GRANT ALL ON SCHEMA public TO public;
  `
    )
    .execute(db)

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
