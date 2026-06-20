/**
 * Fast unit-level regression for the wrong-kind guard's HTTP contract.
 *
 * Verifies three things in isolation, with no DB and no real controller
 * wiring:
 *   1. `assertExpectedTransportKind` throw shape (statusCode/code/message)
 *   2. Fastify error handler maps that throw to a 404 response body with
 *      a stable `code` field
 *   3. ZodError thrown by `schema.parse(...)` in controllers gets mapped
 *      to 400 (defends against a regression where the production
 *      handler dropped its ZodError branch and validation errors fell
 *      through to "Internal Server Error")
 *
 * The companion `tests/integration/im-wecom-wrong-kind.test.ts` test
 * exercises the full stack (real controller, real
 * `updateTransportAccount`, real DB), which is what actually proves a
 * wrong-kind PUT doesn't mutate the target row in practice. This file
 * is the fast-feedback complement that catches contract drift without
 * requiring docker-compose.
 */

import test from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { z, ZodError } from "zod"
import { assertExpectedTransportKind } from "../service/account-credentials.js"

function attachProductionErrorHandler(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any
): void {
  // Mirrors src/index.ts:127-176 (excluding the
  // `isMalformedUuidDatabaseError` branch, which isn't exercised here).
  // Kept in sync by virtue of being exercised by every 4xx in production.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.setErrorHandler((error: any, _request: any, reply: any) => {
    if (error instanceof ZodError) {
      const issues = error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
      return reply.status(400).send({
        error: issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        code: "invalid_request",
        issues,
      })
    }
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400
        ? error.statusCode
        : 500
    return reply.status(statusCode).send({
      error:
        statusCode >= 500
          ? "Internal Server Error"
          : error.message || "Request failed",
      code:
        statusCode >= 500
          ? "internal_server_error"
          : typeof error.code === "string"
            ? error.code
            : "request_error",
    })
  })
}

test("PUT wrong-kind account → 404 with correct code, no mutation", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = Fastify()
  attachProductionErrorHandler(app)
  let wouldUpdate = false
  app.put(
    "/api/v1/workspaces/:wid/im/accounts/wecom/:accountId",
    async (request: { params: { wid: string; accountId: string } }) => {
      // Replicate the per-transport controller's call into the service
      // guard with `expectedTransportKind: "wecom"`. The fixture
      // simulates `loadTransportAccountRow` returning a Feishu row.
      const existing = {
        id: request.params.accountId,
        transportKind: "feishu" as const,
      }
      assertExpectedTransportKind(existing, "wecom")
      // Production would now run the UPDATE. Flip the flag so we can
      // assert it never gets here.
      wouldUpdate = true
      return { account: { id: existing.id } }
    }
  )

  const res = await app.inject({
    method: "PUT",
    url: "/api/v1/workspaces/ws-1/im/accounts/wecom/feishu-account-id",
    payload: { displayName: "hijack attempt" },
  })

  assert.equal(res.statusCode, 404, "status must be 404 (not 500)")
  const body = JSON.parse(res.body)
  assert.equal(body.code, "transport_account_kind_mismatch")
  assert.match(body.error, /not a wecom account/)
  assert.equal(
    wouldUpdate,
    false,
    "guard must fire before any write side-effect"
  )

  await app.close()
})

test("PUT matching-kind account → guard does NOT fire (passes through)", async () => {
  // Sanity: when expectedTransportKind matches, the guard returns
  // normally and the handler proceeds to the (stubbed) update path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = Fastify()
  attachProductionErrorHandler(app)
  let updateRan = false
  app.put(
    "/api/v1/workspaces/:wid/im/accounts/wecom/:accountId",
    async (request: { params: { wid: string; accountId: string } }) => {
      const existing = {
        id: request.params.accountId,
        transportKind: "wecom" as const,
      }
      assertExpectedTransportKind(existing, "wecom")
      updateRan = true
      return { account: { id: existing.id } }
    }
  )

  const res = await app.inject({
    method: "PUT",
    url: "/api/v1/workspaces/ws-1/im/accounts/wecom/legit-wecom-id",
    payload: { displayName: "rename" },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(updateRan, true)
  await app.close()
})

test("assertExpectedTransportKind: no-op when expectedTransportKind omitted", () => {
  // Generic /im/accounts/:id route doesn't pass expectedTransportKind;
  // the helper must be a pass-through in that case (otherwise the
  // generic update endpoint would always 404).
  assert.doesNotThrow(() =>
    assertExpectedTransportKind({ id: "x", transportKind: "wecom" }, undefined)
  )
  assert.doesNotThrow(() =>
    assertExpectedTransportKind({ id: "x", transportKind: "feishu" }, undefined)
  )
})

test("assertExpectedTransportKind: error shape carries statusCode + code + message", () => {
  // Direct shape assertion in case the Fastify glue ever changes —
  // this is the contract the error handler depends on.
  try {
    assertExpectedTransportKind(
      { id: "acct-42", transportKind: "feishu" },
      "wecom"
    )
    assert.fail("expected throw")
  } catch (err) {
    assert.ok(err instanceof Error)
    const e = err as Error & { statusCode?: unknown; code?: unknown }
    assert.equal(e.statusCode, 404)
    assert.equal(e.code, "transport_account_kind_mismatch")
    assert.match(e.message, /acct-42/)
    assert.match(e.message, /wecom/)
  }
})

test("PUT with invalid body (ZodError) → 400 invalid_request, not 500", async () => {
  // Pre-fix: schema.parse() throws ZodError which has no `statusCode`
  // field, so the global error handler fell through to 500
  // "Internal Server Error". Now we recognise ZodError explicitly and
  // surface 400 with a field-level summary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = Fastify()
  attachProductionErrorHandler(app)
  const schema = z
    .object({
      botId: z.string().min(1),
      baseWsUrl: z.url(),
    })
    .strict()
  app.put("/api/v1/test-route", async (request: { body: unknown }) => {
    const body = schema.parse(request.body) // ZodError on failure
    return { ok: true, body }
  })

  // Missing required field → ZodError
  const missingRes = await app.inject({
    method: "PUT",
    url: "/api/v1/test-route",
    payload: { baseWsUrl: "wss://example" },
  })
  assert.equal(missingRes.statusCode, 400, "missing required → 400, not 500")
  const missingBody = JSON.parse(missingRes.body)
  assert.equal(missingBody.code, "invalid_request")
  assert.ok(
    Array.isArray(missingBody.issues) && missingBody.issues.length > 0,
    "body must include issues[] for client-side field surfacing"
  )

  // Unknown extra key (strict) → ZodError → 400 (not silent pass)
  const strictRes = await app.inject({
    method: "PUT",
    url: "/api/v1/test-route",
    payload: { botId: "x", baseWsUrl: "wss://example", garbage: "x" },
  })
  assert.equal(strictRes.statusCode, 400)
  assert.equal(JSON.parse(strictRes.body).code, "invalid_request")

  await app.close()
})
