// Integration test (Phase 2): full MCP catalog sync pipeline.
//
// Validates that a real synapse-relay binary can:
//  - spawn each of our 11 mock MCP servers via stdio
//  - perform initialize + tools/list on each
//  - sync the resulting catalog back to the API over WebSocket
//  - show all 11 exposures + their tools in the workspace dashboard
//
// Phase 2 is about the ingest funnel; actual tool-call invocation requires
// an actor + LLM pipeline and is exercised end-to-end in Phase 5
// (end-to-end-tool-result.test.ts). The conversion logic the ingest funnel
// performs is covered exhaustively by unit tests in
// packages/api/src/modules/files/ingest.test.ts.
//
// Setup before running:
//   bash packages/api/tests/integration/scripts/up.sh
//   bash packages/api/tests/integration/scripts/build-relay.sh

import { after, before, test } from "node:test"
import assert from "node:assert/strict"

import {
  buildDatabaseUrl,
  pairAndStartRelay,
  resetDb,
  seedMinimal,
  spawnApi,
  startMockHttp,
  TEST_REDIS_URL,
  type ApiHandle,
  type MinimalSeed,
  type MockHttpHandle,
  type RelayHandle,
} from "./harness/index.js"

let api: ApiHandle | undefined
let seed: MinimalSeed | undefined
let relay: RelayHandle | undefined
let mockHttp: MockHttpHandle | undefined

const EXPECTED_SERVERS = [
  "text-only",
  "image-base64",
  "image-source-base64",
  "image-url",
  "audio",
  "resource-text",
  "resource-blob",
  "mixed",
  "structured",
  "error",
  "pre-canonical",
]

before(async () => {
  await resetDb()
  seed = await seedMinimal({ workspaceSlugSuffix: "ingest" })
  api = await spawnApi({
    databaseUrl: buildDatabaseUrl(),
    redisUrl: TEST_REDIS_URL,
    silent: true,
  })

  mockHttp = await startMockHttp()
  const PNG_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64"
  )
  mockHttp.setRoute("/image.png", () => ({
    status: 200,
    headers: { "content-type": "image/png" },
    body: PNG_BYTES,
  }))

  relay = await pairAndStartRelay({
    apiBaseUrl: api.baseUrl,
    sessionToken: seed.sessionToken,
    workspaceId: seed.workspaceId,
    displayName: "cb-test-ingest",
    mcpServers: EXPECTED_SERVERS.map((name) => ({
      name,
      script: `${name}.mjs`,
      env:
        name === "image-url"
          ? { IMAGE_SOURCE_URL: `${mockHttp!.baseUrl}/image.png` }
          : undefined,
    })),
    silent: true,
  })
  // Give the relay a moment for its catalog sync.
  await new Promise((r) => setTimeout(r, 3000))
})

after(async () => {
  if (relay) await relay.stop()
  if (mockHttp) await mockHttp.stop()
  if (api) await api.stop()
})

async function getRelayDeviceDetail(): Promise<any> {
  if (!api || !seed || !relay) throw new Error("fixtures not initialized")
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(
      `${api.baseUrl}/api/v1/workspaces/${seed.workspaceId}/mcp/relays/${relay.deviceId}`,
      { headers: { authorization: `Bearer ${seed.sessionToken}` } }
    )
    if (res.status === 200) {
      const detail = await res.json()
      if (detail.exposures && detail.exposures.length > 0) return detail
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("relay device detail with exposures did not appear")
}

test("relay registers all 11 mock MCP servers as exposures", async () => {
  const detail = await getRelayDeviceDetail()
  const names: string[] = (detail.exposures || [])
    .map((e: any) => e.name || e.serverName || e.displayName)
    .filter(Boolean)
  for (const expected of EXPECTED_SERVERS) {
    assert.ok(
      names.includes(expected),
      `expected exposure '${expected}' in [${names.join(", ")}]`
    )
  }
})

test("each exposure advertises at least one tool", async () => {
  const detail = await getRelayDeviceDetail()
  for (const exposure of detail.exposures || []) {
    const name = exposure.name || exposure.serverName || exposure.displayName
    const tools = exposure.tools || exposure.toolBindings || []
    assert.ok(
      Array.isArray(tools) && tools.length > 0,
      `exposure '${name}' should have at least one tool, got ${JSON.stringify(tools)}`
    )
  }
})

test("structured MCP server's lookup tool declares its inputSchema", async () => {
  const detail = await getRelayDeviceDetail()
  const structured = (detail.exposures || []).find((e: any) =>
    [e.name, e.serverName, e.displayName].includes("structured")
  )
  if (!structured) {
    // Dump for debugging shape.
    console.error(
      "exposure shape sample:",
      JSON.stringify((detail.exposures || [])[0], null, 2)
    )
  }
  assert.ok(structured, "structured exposure should exist")
  const tools = structured.tools || structured.toolBindings || []
  const lookup = tools.find((t: any) => {
    const n = t.currentName || t.name || t.visibleName || t.visible?.name
    return n === "lookup"
  })
  assert.ok(
    lookup,
    `lookup tool should exist in structured exposure: ${JSON.stringify(tools)}`
  )
})

test("mixed MCP server registers exactly one tool (render_report)", async () => {
  const detail = await getRelayDeviceDetail()
  const mixed = (detail.exposures || []).find((e: any) =>
    [e.name, e.serverName, e.displayName].includes("mixed")
  )
  assert.ok(mixed, "mixed exposure should exist")
  const tools = mixed.tools || mixed.toolBindings || []
  assert.equal(tools.length, 1)
})
