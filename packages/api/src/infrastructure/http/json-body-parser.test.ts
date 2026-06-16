import test from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import {
  parseJsonBodyWithRawCapture,
  type RawBodyRequest,
} from "./json-body-parser.js"

test("json body parser stores rawBody and parses JSON", async () => {
  const app = Fastify()
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    parseJsonBodyWithRawCapture
  )
  app.post("/echo", async (request) => ({
    body: request.body,
    rawBody: (request as RawBodyRequest).rawBody,
  }))

  const res = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: ' { "ok": true } ',
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    body: { ok: true },
    rawBody: ' { "ok": true } ',
  })
  await app.close()
})

test("json body parser maps blank bodies to an empty object", async () => {
  const app = Fastify()
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    parseJsonBodyWithRawCapture
  )
  app.post("/echo", async (request) => ({
    body: request.body,
    rawBody: (request as RawBodyRequest).rawBody,
  }))

  const res = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: "   ",
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { body: {}, rawBody: "   " })
  await app.close()
})

test("json body parser rejects malformed JSON", async () => {
  const app = Fastify()
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    parseJsonBodyWithRawCapture
  )
  app.post("/echo", async (request) => ({ body: request.body }))

  const res = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: "{",
  })

  assert.equal(res.statusCode, 500)
  await app.close()
})

test("json body parser keeps the legacy non-string fallback", async () => {
  const request = {} as RawBodyRequest
  let parsed: unknown
  let error: Error | null = null

  parseJsonBodyWithRawCapture(
    request,
    Buffer.from("{}") as never,
    (err, body) => {
      error = err
      parsed = body
    }
  )

  assert.equal(error, null)
  assert.deepEqual(parsed, {})
  assert.deepEqual(request.rawBody, Buffer.from("{}"))
})
