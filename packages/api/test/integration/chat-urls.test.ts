/**
 * S4: chat URL namespace unification.
 *
 * - POST /workspaces/:wsId/chat/direct-conversations/open  (new, was /direct-conversations/open)
 * - POST /workspaces/:wsId/chat/conversations/:cid/interactions/:iid/respond
 *      (new, was /conversations/:cid/...)
 * The legacy URLs must 404 after this stage.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createApiClient,
  registerTestUser,
  createTestWorkspace,
} from "./setup.ts"

test("legacy /workspaces/:wsId/direct-conversations/open returns 404", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  const res = await ctx.client.fetch(
    `/workspaces/${ws.id}/direct-conversations/open`,
    {
      method: "POST",
      json: {
        contactKind: "workspace_member",
        workspaceMemberId: "00000000-0000-0000-0000-000000000000",
      },
    }
  )
  assert.equal(res.status, 404)
})

test("new /workspaces/:wsId/chat/direct-conversations/open route is mounted", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  // Hitting with garbage body still proves the route exists: should be 400/404,
  // never 404-from-no-route. We expect 400 (bad request) or 404 (target member
  // missing), but NOT 404 + "Not Found" from missing route.
  const res = await ctx.client.fetch(
    `/workspaces/${ws.id}/chat/direct-conversations/open`,
    {
      method: "POST",
      json: {
        contactKind: "workspace_member",
        workspaceMemberId: "00000000-0000-0000-0000-000000000000",
      },
    }
  )
  assert.notEqual(res.status, 0)
  // Any 4xx/5xx is fine — what matters is the route was reachable, i.e. the
  // body parsed and validated. A 404 from Fastify-route-not-found returns
  // `error: "Not Found"`, which we explicitly reject here.
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.status === 404 && body.error === "Not Found") {
    throw new Error("new route is not mounted")
  }
})

test("legacy /workspaces/:wsId/conversations/:cid/interactions/:iid/respond returns 404", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  const fakeCid = "00000000-0000-0000-0000-000000000000"
  const fakeIid = "00000000-0000-0000-0000-000000000001"
  const res = await ctx.client.fetch(
    `/workspaces/${ws.id}/conversations/${fakeCid}/interactions/${fakeIid}/respond`,
    {
      method: "POST",
      json: { commandId: fakeIid, baseRevision: 1, decision: "reject" },
    }
  )
  // Should be 404 from missing route, NOT 4xx from controller logic.
  assert.equal(res.status, 404)
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  assert.equal(body.error, "Not Found")
})
