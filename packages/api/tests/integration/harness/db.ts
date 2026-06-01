// Database harness for integration tests.
// Connects to this worktree's isolated test postgres (host + port derived per
// worktree by scripts/lib.sh and passed in via DATABASE_URL), drops/recreates
// the database, runs the existing bootstrap.ts to apply schema, then seeds a
// minimal user + workspace + member + auth session.

import crypto from "node:crypto"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import pg from "pg"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKTREE_ROOT = path.resolve(__dirname, "../../../../..")

// Only host + port are dynamic (per-worktree). User / password / database name
// are fixed values — keeping them constant avoids any escaping concern in
// buildDatabaseUrl() and in the `DROP DATABASE "..."` identifier (the DB name
// is a controlled literal, never user input).
let _dbUrl: URL
try {
  _dbUrl = new URL(
    process.env.DATABASE_URL ??
      "postgresql://synapse:test_password@127.0.0.1:55433/synapse_test"
  )
} catch {
  throw new Error(
    "Invalid DATABASE_URL — run integration tests via tests/integration/scripts/run-test.sh"
  )
}

export const TEST_PG_HOST = _dbUrl.hostname || "127.0.0.1"
export const TEST_PG_PORT = Number.parseInt(_dbUrl.port || "55433", 10)
if (!Number.isFinite(TEST_PG_PORT)) {
  throw new Error(`DATABASE_URL port is not a number: "${_dbUrl.port}"`)
}
export const TEST_PG_USER = "synapse"
export const TEST_PG_PASSWORD = "test_password"
export const TEST_PG_ADMIN_DB = "postgres"
export const TEST_PG_DB = "synapse_test"
export const TEST_REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:56380"

export function buildDatabaseUrl(db = TEST_PG_DB) {
  return `postgresql://${TEST_PG_USER}:${TEST_PG_PASSWORD}@${TEST_PG_HOST}:${TEST_PG_PORT}/${db}`
}

export interface MinimalSeed {
  userId: string
  userEmail: string
  workspaceId: string
  workspaceMemberId: string
  sessionToken: string
}

/**
 * Shut down the API-side connection pools that get opened transitively by
 * importing modules like execution/service.js. Call from an `after` hook
 * so the test process can actually exit instead of hanging on open
 * pg/redis sockets.
 *
 * Phase 10: previously tests had to be killed via SIGKILL after a long
 * timeout because the kysely pg pool and BullMQ redis connections kept
 * the event loop alive forever.
 */
export async function teardownApiConnections(): Promise<void> {
  try {
    const { closeDatabasePool } =
      await import("../../../src/infrastructure/database/index.js")
    await closeDatabasePool().catch(() => undefined)
  } catch {}
  try {
    const { shutdownRedisConnections } =
      await import("../../../src/infrastructure/redis/index.js")
    await shutdownRedisConnections().catch(() => undefined)
  } catch {}
}

async function withAdminClient<T>(
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({
    host: TEST_PG_HOST,
    port: TEST_PG_PORT,
    user: TEST_PG_USER,
    password: TEST_PG_PASSWORD,
    database: TEST_PG_ADMIN_DB,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function withTestClient<T>(
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({
    host: TEST_PG_HOST,
    port: TEST_PG_PORT,
    user: TEST_PG_USER,
    password: TEST_PG_PASSWORD,
    database: TEST_PG_DB,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

export async function resetDb(): Promise<void> {
  // Safety guardrails for the most destructive operation in the suite
  // (DROP/CREATE DATABASE). Enforced here so EVERY caller is covered, including
  // test files that don't carry the per-file run guard. The sentinel proves we
  // were launched via run-test.sh, and the port floor refuses anything pointing
  // at a non-test stack (production pg is 5432; test bands start at 55000).
  if (process.env.SYNAPSE_INT_TEST !== "1") {
    throw new Error(
      "resetDb() refused: SYNAPSE_INT_TEST!=1 — run via tests/integration/scripts/run-test.sh"
    )
  }
  if (TEST_PG_PORT < 50000) {
    throw new Error(
      `resetDb() refused: DATABASE_URL port ${TEST_PG_PORT} is not a per-worktree test stack port`
    )
  }

  await withAdminClient(async (client) => {
    // Terminate any leftover connections to the test DB before dropping.
    await client.query(
      `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `,
      [TEST_PG_DB]
    )
    await client.query(`DROP DATABASE IF EXISTS "${TEST_PG_DB}"`)
    await client.query(`CREATE DATABASE "${TEST_PG_DB}"`)
  })

  // Use the existing bootstrap.ts via tsx — it knows how to apply schema.sql
  // idempotently and record schema_migrations rows. Pass DATABASE_URL via env.
  const bootstrapEntry = path.join(
    WORKTREE_ROOT,
    "packages/api/src/infrastructure/database/bootstrap.ts"
  )
  const result = spawnSync("npx", ["tsx", bootstrapEntry], {
    cwd: WORKTREE_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: buildDatabaseUrl(),
    },
    encoding: "utf8",
    timeout: 120_000,
  })
  if (result.error) {
    const cause = result.error as NodeJS.ErrnoException
    throw new Error(
      `bootstrap.ts could not be launched (${cause.code ?? "unknown"}): ${cause.message}. ` +
        `Make sure dependencies are installed (run 'npm install' in ${WORKTREE_ROOT}).`
    )
  }
  if (result.status !== 0) {
    throw new Error(
      `bootstrap.ts failed (exit ${result.status}, signal ${result.signal ?? "none"}):\n` +
        `stdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`
    )
  }
}

function generateSessionToken(): string {
  return crypto.randomBytes(48).toString("base64url")
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

function tokenHint(token: string): string {
  return token.slice(0, 8)
}

export async function seedMinimal(
  opts: {
    email?: string
    workspaceName?: string
    workspaceSlugSuffix?: string
  } = {}
): Promise<MinimalSeed> {
  const email = opts.email || "int-test@synapse.dev"
  const workspaceName = opts.workspaceName || "Canonical Content Blocks Test"
  const workspaceSlug = (
    opts.workspaceSlugSuffix
      ? `int-test-${opts.workspaceSlugSuffix}`
      : `int-test-${crypto.randomBytes(3).toString("hex")}`
  ).toLowerCase()
  const sessionToken = generateSessionToken()
  const sessionExpiresAt = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000
  ).toISOString()

  return withTestClient(async (client) => {
    const userRow = await client.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [email, "CB Test User", "test-not-a-real-hash"]
    )
    const userId = userRow.rows[0].id

    const workspaceRow = await client.query<{ id: string }>(
      `INSERT INTO workspaces (name, slug, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [workspaceName, workspaceSlug, userId]
    )
    const workspaceId = workspaceRow.rows[0].id

    const memberRow = await client.query<{ id: string }>(
      `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
       VALUES ($1, $2, 'admin')
       RETURNING id`,
      [workspaceId, userId]
    )
    const workspaceMemberId = memberRow.rows[0].id

    await client.query(
      `INSERT INTO auth_sessions (user_id, client_type, transport, token_hash, token_hint, expires_at)
       VALUES ($1, 'web', 'token', $2, $3, $4)`,
      [
        userId,
        tokenHash(sessionToken),
        tokenHint(sessionToken),
        sessionExpiresAt,
      ]
    )

    return {
      userId,
      userEmail: email,
      workspaceId,
      workspaceMemberId,
      sessionToken,
    }
  })
}
