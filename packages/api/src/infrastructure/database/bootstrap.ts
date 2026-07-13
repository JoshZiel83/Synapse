import { readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import { createHash } from "node:crypto"
import { sql } from "kysely"
import { db } from "./kysely.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const __filename = fileURLToPath(import.meta.url)
const schemaSql = readFileSync(join(__dirname, "schema.sql"), "utf-8")
const schemaSqlWithoutExtensions = schemaSql.replace(
  /^CREATE EXTENSION IF NOT EXISTS .+;[\r]?\n?/gm,
  ""
)

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
// Slug bumped for the runtime/sandbox generalization (the device_* substrate was
// rewritten onto a runtimes CTI supertype; NO back-compat). Any pre-existing DB at
// an older slug now fail-louds on boot (decideBootstrapAction → "fail") and must
// db:rebuild, instead of silently noop-ing on a schema that lacks runtimes/sandboxes.
// Slug kept <=64 chars (VARCHAR(64); bootstrap.test.ts enforces); full narrative
// lives in the (unbounded) description.
export const CURRENT_SCHEMA_VERSION = "2026-07-12-sandbox-r2"
export const CURRENT_SCHEMA_DESCRIPTION =
  "Sandbox review R2: sandboxes gain nullable platform/arch columns (real OS facts for the capability projection's bundle/OS-guard logic — local adapter uses the API host, docker the container, off-box provider-declared; NULL still degrades to the projection's linux/x64 default). A deferred mode<->service_kind constraint trigger enforces resident=>device_runtime / bare=>bare_dataplane on sandbox runtimes (the invariant previously lived only in TS mint code). The reserved-but-unconsumed device_sync_sources table + its 3 enums + runtime_exposures.sync_source_id FK are dropped. Requires db:rebuild for existing databases (no in-place migrations during initial design). " +
  "Runtime/sandbox generalization: the device_* substrate is rewritten onto a `runtimes` CTI supertype with devices (kind='device') + sandboxes (kind='sandbox', device-less) detail tables and runtime_* services/sessions/operations/capabilities/exposures/authorizations; device_* tables/columns removed, NO back-compat. Requires db:rebuild for existing databases (no in-place migrations during initial design). " +
  "IM inbound dedupe hardening: transport_message_links now has a partial unique index on non-empty inbound external_message_id per account+endpoint, so concurrent duplicate inbound messages cannot create multiple link rows. Requires db:rebuild for existing databases (no in-place migrations during initial design). " +
  "Datetime hardening: created_at/updated_at columns that default to NOW() are now NOT NULL by schema contract, all persisted instants remain TIMESTAMPTZ-backed Dates in generated/db.ts, shared protocol timestamps are branded IsoInstantString values, and schema bootstrap installs a generic updated_at auto-touch trigger across every public base table that exposes updated_at. Requires db:rebuild for existing databases (no in-place migrations during initial design). " +
  "Task unification naming cleanup: human-facing requests are first-class tool_call_tasks; removed the remaining task-response compatibility naming from response surfaces, active task pointers, source task pointers, remote-agent group task grants, and remote-agent run task linkage. Requires db:rebuild for existing databases (no in-place migrations during initial design). " +
  "Tool provenance & routing refactor: tool_calls.tool_name now holds the model-facing WIRE name; added immutable source_snapshot JSONB + GENERATED source_kind (system|plugin|runtime) + soft pointers plugin_installation_id/runtime_tool_id (ON DELETE SET NULL, snapshot is the durable audit truth) with a source↔column consistency CHECK; dropped legacy tool_calls.plugin_id/device_id and tool_execution_attempts.plugin_id/device_id/instance_key (attempt provenance derives from the parent tool_calls row). Routing no longer parses tool names — projection mints deterministic ToolRefs and a per-turn NameRegistry maps wire↔toolId. Requires db:rebuild for existing databases (no in-place migrations during initial design). " +
  "(PRIOR) Chat multi-client broadcast correctness: workspace_member_sync_events.member_seq commit-ordered client sync cursor. " +
  "(PRIOR) Soft-delete: deleted_at on 24 root tables, _live views, sd_reject_delete + sd_assert_parent_live triggers, sd_* SECURITY DEFINER purge fns. " +
  "(PRIOR) Account/auth redesign onto Better Auth (better-auth@1.6.13). " +
  "(PRIOR) MCP official remote endpoints: plugin_package_version_specs_transport enum gains 'sse'. Server-side actor sandbox: file_mounts.sandbox_backend/sandbox_resource_id. conversation-type derived-IM + file-service CAS carried forward unchanged."

// STRUCTURAL recurrence guard (P1): the version actually written to + compared
// against schema_migrations is the human slug PLUS a hash of the applied schema
// DDL. This makes the fail-loud guard self-enforcing — ANY edit to schema.sql
// changes EFFECTIVE_SCHEMA_VERSION, so a DB bootstrapped on an older schema never
// matches (decideBootstrapAction → "fail" → db:rebuild), with NO reliance on a
// developer remembering to bump CURRENT_SCHEMA_VERSION. The human slug is still
// bumped for the description/readability, but DETECTION no longer depends on it —
// closing the recurrence the review flagged (schema.sql rewritten, slug forgotten
// → silent noop on a stale schema). 12 hex chars keeps this well under VARCHAR(64)
// (slug<=51 + '-' + 12 <= 64; bootstrap.test enforces the length invariant).
export const SCHEMA_CONTENT_HASH = createHash("sha256")
  .update(schemaSqlWithoutExtensions)
  .digest("hex")
  .slice(0, 12)
export const EFFECTIVE_SCHEMA_VERSION = `${CURRENT_SCHEMA_VERSION}-${SCHEMA_CONTENT_HASH}`

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
      WHERE version = ${EFFECTIVE_SCHEMA_VERSION}
    ) AS exists`.execute(db)
  return result.rows[0]?.exists === true
}

async function recordCurrentSchemaVersion() {
  await sql`
    INSERT INTO schema_migrations (version, description)
    VALUES (${EFFECTIVE_SCHEMA_VERSION}, ${CURRENT_SCHEMA_DESCRIPTION})
    ON CONFLICT (version) DO NOTHING`.execute(db)
}

async function applyBootstrapSchema() {
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(922337203685477000)`.execute(trx)
    await sql
      .raw(
        `
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE EXTENSION IF NOT EXISTS "vector";
      CREATE EXTENSION IF NOT EXISTS "pg_trgm";
    `
      )
      .execute(trx)
  })
  // schemaSql is a trusted local file (schema.sql) containing the full DDL with
  // multiple statements — must run as raw SQL, not a parameterized fragment.
  await sql.raw(schemaSqlWithoutExtensions).execute(db)
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
    currentVersion: EFFECTIVE_SCHEMA_VERSION,
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
