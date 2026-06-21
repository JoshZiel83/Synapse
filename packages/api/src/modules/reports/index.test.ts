import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import reportsModule from "./index.js"

async function build() {
  const app = Fastify()
  await app.register(reportsModule)
  await app.ready()
  return app
}

test("202 + accepted count for application/reports+json array", async () => {
  const app = await build()
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: { "content-type": "application/reports+json" },
    payload: JSON.stringify([
      {
        type: "network-error",
        body: { phase: "dns", type: "dns.name_not_resolved" },
      },
      { type: "deprecation", body: { id: "x" } },
    ]),
  })
  assert.equal(res.statusCode, 202)
  assert.equal(JSON.parse(res.body).accepted, 2)
  await app.close()
})

test("202 for legacy single-object application/csp-report", async () => {
  const app = await build()
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: { "content-type": "application/csp-report" },
    payload: JSON.stringify({
      "csp-report": {
        "document-uri": "https://s/p",
        "blocked-uri": "https://e/x.js",
      },
    }),
  })
  assert.equal(res.statusCode, 202)
  assert.equal(JSON.parse(res.body).accepted, 1)
  await app.close()
})

test("415 for a content-type we do not accept (application/json)", async () => {
  const app = await build()
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify([{ type: "network-error", body: {} }]),
  })
  assert.equal(res.statusCode, 415)
  await app.close()
})

test("unknown report types are silently dropped (accepted:0, still 202)", async () => {
  const app = await build()
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: { "content-type": "application/reports+json" },
    payload: JSON.stringify([
      { type: "totally-made-up", body: { evil: true } },
    ]),
  })
  assert.equal(res.statusCode, 202)
  assert.equal(JSON.parse(res.body).accepted, 0)
  await app.close()
})

test("malformed JSON body does not 500 (treated as 0 reports)", async () => {
  const app = await build()
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: { "content-type": "application/reports+json" },
    payload: "{ not valid json ",
  })
  assert.equal(res.statusCode, 202)
  assert.equal(JSON.parse(res.body).accepted, 0)
  await app.close()
})
