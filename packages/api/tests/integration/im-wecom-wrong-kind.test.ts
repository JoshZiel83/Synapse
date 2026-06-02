/**
 * Real HTTP + service + DB regression for cross-kind PUT routing:
 *
 *   PUT /api/v1/workspaces/:ws/im/accounts/wecom/:feishu-account-id
 *
 * Without `expectedTransportKind` plumbing, this used to silently
 * rewrite the Feishu account (displayName, owner, inboundActor) through
 * the WeCom endpoint. The unit-level guard
 * (`controller/wecom-wrong-kind-http.test.ts`) covers the helper +
 * Fastify error mapping in isolation; this file exercises the FULL
 * stack: real controller registration → real
 * `updateTransportAccount` → real DB → real error handler. If a future
 * refactor moves the guard after the write, or drops
 * `expectedTransportKind` from the controller call, this test catches
 * it as a row mutation that should not have happened.
 *
 * Run via:  npm run test:integration -w packages/api
 * (requires the docker-compose stack — run-test.sh sets SYNAPSE_INT_TEST=1
 * and the per-worktree DATABASE_URL/REDIS_URL)
 */

if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "im-wecom-wrong-kind.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh"
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import {
  createTestWorkspace,
  registerTestUser,
  setupChatStack,
  teardownChatStack,
  type ChatStack,
} from "./harness/index.js"

let stack: ChatStack | undefined

before(async () => {
  stack = await setupChatStack()
})

after(async () => {
  if (stack) await teardownChatStack(stack)
})

interface AccountResponse {
  account: {
    id: string
    transportKind: string
    displayName: string
  }
}

test("PUT /im/accounts/wecom/:id against a Feishu account → 404, no row mutation", async () => {
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)

  // Seed: create a Feishu account through its own controller route.
  // `status: "disabled"` keeps the runtime manager from actually trying
  // to dial real Feishu / WeCom endpoints with the bogus fixture
  // credentials — see service/account-credentials.ts (disabled status
  // skips connector validation) and runtime.ts:listActiveTransportAccounts
  // (reconcile loop ignores non-active rows). The guard, mutation, and
  // error-mapping paths under test are all status-independent.
  const created = await ctx.client.json<AccountResponse>(
    `/workspaces/${ws.id}/im/accounts/feishu`,
    {
      method: "POST",
      json: {
        displayName: "Original Feishu display name",
        connectionMode: "long_connection",
        appId: "cli_test_app",
        appSecret: "test-secret-not-real",
        status: "disabled",
      },
    }
  )
  const feishuId = created.account.id
  assert.equal(created.account.transportKind, "feishu")
  const originalDisplayName = created.account.displayName

  // Hijack attempt: PUT through the WeCom route, targeting the Feishu
  // account id. Should be rejected.
  const res = await ctx.client.fetch(
    `/workspaces/${ws.id}/im/accounts/wecom/${feishuId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Hijacked by WeCom endpoint",
      }),
    }
  )

  // (1) Status: 404 (NOT 500 — the pre-fix regression mapped plain
  //     `throw new Error(...)` to "Internal Server Error")
  assert.equal(res.status, 404, `expected 404, got ${res.status}`)
  const body = (await res.json()) as { code?: string; error?: string }
  // (2) Code: distinguishable from generic "not found"
  assert.equal(body.code, "transport_account_kind_mismatch")

  // (3) No mutation: re-fetch the Feishu account and confirm the
  //     displayName is unchanged. This is the bug-class assertion —
  //     without the service-layer guard, the UPDATE would have run and
  //     the displayName would now read "Hijacked by WeCom endpoint".
  const refreshed = await ctx.client.json<{
    accounts: Array<{ id: string; transportKind: string; displayName: string }>
  }>(`/workspaces/${ws.id}/im/accounts`)
  const stillFeishu = refreshed.accounts.find((a) => a.id === feishuId)
  assert.ok(stillFeishu, "feishu account should still exist")
  assert.equal(
    stillFeishu!.transportKind,
    "feishu",
    "transport_kind must not have been rewritten"
  )
  assert.equal(
    stillFeishu!.displayName,
    originalDisplayName,
    "displayName must not have been mutated by the wrong-kind PUT"
  )
})

test("PUT /im/accounts/wecom/:id against the matching WeCom account → 200 + actual mutation", async () => {
  // Sanity: legitimate same-kind PUT still works. If the guard is too
  // aggressive (e.g. expectedTransportKind incorrectly compared against
  // a different case) this would also 404 and break the WeCom admin UI.
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)

  const created = await ctx.client.json<AccountResponse>(
    `/workspaces/${ws.id}/im/accounts/wecom`,
    {
      method: "POST",
      json: {
        displayName: "Original WeCom display name",
        botId: "bot_id_test",
        secret: "secret_test_not_real",
        status: "disabled",
      },
    }
  )
  const wecomId = created.account.id
  assert.equal(created.account.transportKind, "wecom")

  const renamed = await ctx.client.json<AccountResponse>(
    `/workspaces/${ws.id}/im/accounts/wecom/${wecomId}`,
    {
      method: "PUT",
      json: { displayName: "Renamed WeCom display name" },
    }
  )
  assert.equal(renamed.account.displayName, "Renamed WeCom display name")
})

test("PUT /im/accounts/wecom/:id with invalid baseWsUrl scheme → 400 with invalid_request (not 500)", async () => {
  // Companion regression for the Zod-error-to-500 finding: the global
  // error handler now recognises ZodError and surfaces 400 with a
  // descriptive body. Pre-fix, hitting an http:// baseWsUrl through the
  // typed route would have returned "Internal Server Error" because the
  // ZodError had no `statusCode` field.
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)

  const created = await ctx.client.json<AccountResponse>(
    `/workspaces/${ws.id}/im/accounts/wecom`,
    {
      method: "POST",
      json: {
        displayName: "Wecom for schema-error test",
        botId: "bot_id_test_2",
        secret: "secret_test_2",
        status: "disabled",
      },
    }
  )

  const badUrlRes = await ctx.client.fetch(
    `/workspaces/${ws.id}/im/accounts/wecom/${created.account.id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseWsUrl: "http://not-wss.example" }),
    }
  )
  assert.equal(
    badUrlRes.status,
    400,
    `expected 400 for invalid scheme, got ${badUrlRes.status}`
  )
  const badBody = (await badUrlRes.json()) as { code?: string }
  assert.equal(badBody.code, "invalid_request")
})

test("POST /im/accounts (generic) with WeCom + unsupported connectionMode → 400, not 500", async () => {
  // Pre-fix: assertSupportedConnectionMode threw a plain Error which
  // mapped to 500 "Internal Server Error". WeCom only supports
  // long_connection (per WECOM_CONNECTOR_CAPABILITY) so a generic-route
  // POST with `connectionMode: "webhook"` must surface as 400 with
  // code `transport_connection_mode_unsupported`. The wecom-specific
  // POST route uses z.literal("long_connection") and never reaches the
  // service-level guard — this is the bypass surface.
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)

  const res = await ctx.client.fetch(`/workspaces/${ws.id}/im/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transportKind: "wecom",
      accountKey: "generic-route-key",
      displayName: "Generic route attempt",
      connectionMode: "webhook", // ← WeCom doesn't support this
      credentials: { botId: "x", secret: "y" },
      status: "disabled",
    }),
  })
  assert.equal(
    res.status,
    400,
    `expected 400 for unsupported connectionMode, got ${res.status}`
  )
  const body = (await res.json()) as { code?: string; error?: string }
  assert.equal(body.code, "transport_connection_mode_unsupported")
  assert.match(body.error ?? "", /wecom/)
  assert.match(body.error ?? "", /webhook/)
})

test("POST /im/accounts (generic) with WeCom + non-string baseWsUrl → 400, not silent drop", async () => {
  // Pre-fix: extractWecomConfig silently dropped non-string baseWsUrl
  // values; the POST returned 201 with empty config and the caller
  // never learned their value was thrown away. Now it surfaces as 400
  // (`transport_config_invalid` from the service wrapper around
  // validateWecomConfig).
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)

  const res = await ctx.client.fetch(`/workspaces/${ws.id}/im/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transportKind: "wecom",
      accountKey: "generic-bad-config",
      displayName: "non-string baseWsUrl",
      connectionMode: "long_connection",
      credentials: { botId: "x", secret: "y" },
      config: { baseWsUrl: 12345 }, // ← not a string
    }),
  })
  assert.equal(
    res.status,
    400,
    `expected 400 for non-string baseWsUrl, got ${res.status}`
  )
  const body = (await res.json()) as { code?: string }
  assert.equal(body.code, "transport_config_invalid")
})
