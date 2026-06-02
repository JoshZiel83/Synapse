// Sanity test for Phase 0 — verifies the test scaffolding works end-to-end:
// 1. Test postgres + redis are reachable (assumes scripts/up.sh has run).
// 2. resetDb + seedMinimal produce a usable workspace + session token.
// 3. spawnApi launches a healthy API on the per-worktree API port (derived by
//    scripts/lib.sh; see BASE_URL).
//
// Device-runtime v3 (PR #20+): the relay binary is gone, so the relay-pairing
// portion of this test has been removed. Device pairing is exercised in
// dedicated device-runtime integration tests.

import { after, before, test } from "node:test"
import assert from "node:assert/strict"

import {
  spawnApi,
  type ApiHandle,
  buildDatabaseUrl,
  TEST_REDIS_URL,
  resetDb,
  seedMinimal,
  type MinimalSeed,
} from "./harness/index.js"

let api: ApiHandle | undefined
let seed: MinimalSeed | undefined

before(async () => {
  await resetDb()
  seed = await seedMinimal({ workspaceSlugSuffix: "sanity" })
  api = await spawnApi({
    databaseUrl: buildDatabaseUrl(),
    redisUrl: TEST_REDIS_URL,
    silent: true,
  })
})

after(async () => {
  if (api) await api.stop()
})

test("sanity: API responds to /api/v1/health", async () => {
  assert.ok(api, "api should be spawned")
  assert.ok(seed, "seed should exist")
  const res = await fetch(`${api!.baseUrl}/api/v1/health`)
  assert.equal(res.status, 200)
})
