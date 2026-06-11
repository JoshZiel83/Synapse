/**
 * Unit regression for the §5.3 route-surface markers (appRoute / wireRoute).
 *
 * These lock the envelope + status contract that the whole mixed-module
 * migration depends on:
 *   - appRoute wraps the handler's return value in { data } via sendData.
 *   - appRoute PRESERVES a status the handler set before returning (e.g.
 *     reply.status(201) for a create) — a prior bug let sendData's default 200
 *     clobber it, so created resources silently returned 200.
 *   - appRoute no-ops when the handler returns undefined / already sent (204
 *     writes, auth-deny 403, early error sends) — no double-send.
 *   - wireRoute never wraps — the handler's bare payload is sent verbatim.
 *
 * No DB, no real controllers — just Fastify inject against the two helpers.
 */

import test from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { z } from "zod"
import { appRoute, wireRoute } from "./route.js"

const ViewSchema = z.object({ id: z.string(), name: z.string() })

test("appRoute wraps the returned value in { data } (200)", async () => {
  const app = Fastify()
  appRoute(app, "GET", "/thing", { schema: ViewSchema }, async () => ({
    id: "a",
    name: "x",
  }))
  const res = await app.inject({ method: "GET", url: "/thing" })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { data: { id: "a", name: "x" } })
  await app.close()
})

test("appRoute preserves a handler-set 201 (create) alongside the { data } wrap", async () => {
  const app = Fastify()
  appRoute(
    app,
    "POST",
    "/things",
    { schema: ViewSchema },
    async (_req, reply) => {
      reply.status(201)
      return { id: "b", name: "y" }
    }
  )
  const res = await app.inject({ method: "POST", url: "/things" })
  assert.equal(res.statusCode, 201, "201 must survive the sendData wrap")
  assert.deepEqual(res.json(), { data: { id: "b", name: "y" } })
  await app.close()
})

test("appRoute no-ops on undefined (204 no-content write)", async () => {
  const app = Fastify()
  appRoute(
    app,
    "DELETE",
    "/things/:id",
    { schema: ViewSchema },
    async (_req, reply): Promise<undefined> => {
      reply.status(204).send()
      return undefined
    }
  )
  const res = await app.inject({ method: "DELETE", url: "/things/1" })
  assert.equal(res.statusCode, 204)
  assert.equal(res.body, "")
  await app.close()
})

test("appRoute no-ops when the handler already sent (auth-deny / error path)", async () => {
  const app = Fastify()
  appRoute(
    app,
    "GET",
    "/guarded",
    { schema: ViewSchema },
    async (_req, reply) => {
      reply.status(403).send({ error: "forbidden" })
      return undefined
    }
  )
  const res = await app.inject({ method: "GET", url: "/guarded" })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.json(), { error: "forbidden" })
  await app.close()
})

test("wireRoute sends the bare payload (no { data } wrap)", async () => {
  const app = Fastify()
  wireRoute(app, "POST", "/wire", {}, async (_req, reply) => {
    reply.send({ device_id: "d1", bare: true })
  })
  const res = await app.inject({ method: "POST", url: "/wire" })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { device_id: "d1", bare: true })
  await app.close()
})

test("appRoute parses through the schema (z.output is sent, not z.input)", async () => {
  // a schema with a transform proves the value is parsed, not passed through.
  const TransformSchema = z.object({
    n: z.coerce.number(),
  })
  const app = Fastify()
  appRoute(app, "GET", "/coerce", { schema: TransformSchema }, async () => ({
    n: "42" as unknown as number,
  }))
  const res = await app.inject({ method: "GET", url: "/coerce" })
  assert.deepEqual(res.json(), { data: { n: 42 } }, "coerce transform must run")
  await app.close()
})
