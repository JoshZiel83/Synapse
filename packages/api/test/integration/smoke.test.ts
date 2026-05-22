/**
 * Stage 0 smoke test for the integration harness.
 *
 * Verifies:
 * 1. The staging API health endpoint is reachable.
 * 2. /auth/register creates a user and returns a token.
 * 3. The chat bootstrap endpoint responds for the new user's default workspace.
 *
 * Run:
 *   source infrastructure/scripts/staging-env.sh
 *   npm run test:integration -w packages/api
 *
 * Or directly:
 *   STAGING_API_URL=http://127.0.0.1:<NGINX_PORT>/api/v1 \
 *     tsx --test packages/api/test/integration/smoke.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createApiClient,
  registerTestUser,
  createTestWorkspace,
} from "./setup.ts"

test("staging API health endpoint reports core services up", async () => {
  const client = createApiClient()
  const health = await client.json<{
    status: string
    services: { database: boolean; databaseSchema: boolean; redis: boolean }
  }>("/health")
  // Memory embedding runtime may be "error" on a fresh staging stack with
  // MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD=false — that's expected. We only
  // require DB + Redis + schema to be live.
  assert.equal(health.services.database, true, "database must be up")
  assert.equal(health.services.databaseSchema, true, "schema must be applied")
  assert.equal(health.services.redis, true, "redis must be up")
  assert.ok(
    health.status === "healthy" || health.status === "degraded",
    `unexpected status: ${health.status}`
  )
})

test("register flow returns a token-bearing session", async () => {
  const client = createApiClient()
  const ctx = await registerTestUser(client)
  assert.ok(ctx.sessionToken.length > 10, "sessionToken should be non-empty")
  assert.match(ctx.user.email, /@synapse\.test$/)
})

test("authenticated user can create a workspace and bootstrap chat", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  assert.ok(ws.id, "workspace must have id")

  const bootstrap = await ctx.client.json<{
    workspaceMemberId: string
    conversations: unknown[]
    nextInboxCursor: number
  }>(`/workspaces/${ws.id}/chat/bootstrap`)

  assert.ok(bootstrap.workspaceMemberId, "workspaceMemberId required")
  assert.ok(Array.isArray(bootstrap.conversations))
  assert.equal(typeof bootstrap.nextInboxCursor, "number")
})
