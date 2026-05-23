// Sanity test for Phase 0 — verifies the full test scaffolding works end-to-end:
// 1. Test postgres + redis are reachable (assumes scripts/up.sh has run).
// 2. resetDb + seedMinimal produce a usable workspace + session token.
// 3. spawnApi launches a healthy API on port 38091.
// 4. Relay binary is built (scripts/build-relay.sh has run).
// 5. pairAndStartRelay completes the WS handshake and registers the device.
// 6. The API dashboard lists the device.
//
// Does NOT verify CanonicalContentBlock pipeline — that's for Phase 2.

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
  pairAndStartRelay,
  waitForRelayDeviceReady,
  type RelayHandle,
} from "./harness/index.js"

let api: ApiHandle | undefined
let relay: RelayHandle | undefined
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
  if (relay) await relay.stop()
  if (api) await api.stop()
})

test("sanity: API responds to /api/v1/health", async () => {
  assert.ok(api, "api should be spawned")
  const res = await fetch(`${api!.baseUrl}/api/v1/health`)
  assert.equal(res.status, 200)
})

test("sanity: relay pairs, connects, appears in dashboard", async () => {
  assert.ok(api, "api should be spawned")
  assert.ok(seed, "seed should exist")

  relay = await pairAndStartRelay({
    apiBaseUrl: api!.baseUrl,
    sessionToken: seed!.sessionToken,
    workspaceId: seed!.workspaceId,
    displayName: "int-test-sanity",
    mcpServers: [{ name: "text-only", script: "text-only.mjs" }],
    silent: false,
  })

  await waitForRelayDeviceReady({
    apiBaseUrl: api!.baseUrl,
    sessionToken: seed!.sessionToken,
    workspaceId: seed!.workspaceId,
    deviceId: relay.deviceId,
    timeoutMs: 15_000,
  })

  // Confirm via dashboard
  const res = await fetch(
    `${api!.baseUrl}/api/v1/workspaces/${seed!.workspaceId}/mcp/relays`,
    { headers: { authorization: `Bearer ${seed!.sessionToken}` } }
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    devices?: Array<{ deviceId?: string; id?: string }>
  }
  const ids = (body.devices || []).map((d) => d.deviceId || d.id || "")
  assert.ok(ids.includes(relay.deviceId), `dashboard devices=${ids.join(",")}`)
})
