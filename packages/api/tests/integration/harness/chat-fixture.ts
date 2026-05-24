// Common setup for the chat / route / WS integration tests that were
// migrated off the legacy STAGING_API_URL harness.
//
// Each test file does:
//
//   import { setupChatStack, teardownChatStack, type ChatStack } from "./chat-fixture.js"
//   let stack: ChatStack
//   before(async () => { stack = await setupChatStack() })
//   after(async () => { await teardownChatStack(stack) })
//
//   test("...", async () => {
//     const ctx = await registerTestUser(stack.baseClient)
//     ...
//   })
//
// Calling setupChatStack() in `before`:
//   1. resets the worktree-isolated synapse_test DB (drop / create / bootstrap schema)
//   2. seeds the minimal user, plus the official actor catalog so that
//      `POST /api/v1/workspaces` can install per-workspace actor instances
//      without 500ing on "Official actor templates are missing."
//   3. spawns the API on 127.0.0.1:38091
//   4. returns an unauthenticated ApiClient pointed at /api/v1
//
// Calling teardownChatStack() in `after`:
//   1. stops the API process
//   2. closes the API's pg / redis pools that this test transitively opened

import { spawnApi, type ApiHandle, TEST_API_BASE_URL } from "./api-process.js"
import {
  buildDatabaseUrl,
  resetDb,
  seedMinimal,
  teardownApiConnections,
  TEST_REDIS_URL,
  type MinimalSeed,
} from "./db.js"
import { createApiClient, type ApiClient } from "./client.js"

export interface ChatStack {
  api: ApiHandle
  baseClient: ApiClient
  seed: MinimalSeed
}

export async function setupChatStack(opts?: {
  silent?: boolean
}): Promise<ChatStack> {
  await resetDb()
  const seed = await seedMinimal({ workspaceSlugSuffix: "chat-fixture" })
  // POST /api/v1/workspaces fails with 500 if the official actor catalog
  // is empty (loadOfficialActorTemplates throws "Official actor templates
  // are missing."). Tests that exercise the workspace-create flow need
  // these rows installed once per DB reset.
  const { seedOfficialActorCatalog } =
    await import("../../../src/infrastructure/database/seeds/actors/seed-official-actors.js")
  await seedOfficialActorCatalog(seed.userId)
  const api = await spawnApi({
    databaseUrl: buildDatabaseUrl(),
    redisUrl: TEST_REDIS_URL,
    silent: opts?.silent ?? true,
  })
  const baseClient = createApiClient({ baseUrl: `${TEST_API_BASE_URL}/api/v1` })
  return { api, baseClient, seed }
}

export async function teardownChatStack(stack: ChatStack): Promise<void> {
  try {
    await stack.api.stop()
  } finally {
    await teardownApiConnections()
  }
}
