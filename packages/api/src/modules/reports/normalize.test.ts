import { test } from "node:test"
import assert from "node:assert/strict"
import { parseReportsJson, parseCspReport } from "./normalize.js"

test("parseReportsJson keeps allowlisted types and maps user_agent (snake_case)", () => {
  const out = parseReportsJson([
    {
      type: "network-error",
      age: 20,
      url: "https://site/x",
      user_agent: "Mozilla/5.0",
      body: { phase: "connection", type: "tcp.timed_out" },
    },
    {
      type: "csp-violation",
      age: 1,
      url: "https://site/y",
      body: { blockedURL: "https://evil/x.js", disposition: "enforce" },
    },
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].reportType, "network-error")
  assert.equal(out[0].userAgent, "Mozilla/5.0")
  assert.equal(out[0].body.phase, "connection")
  assert.equal(out[1].reportType, "csp-violation")
})

test("parseReportsJson drops unknown/missing types and non-array input", () => {
  assert.deepEqual(parseReportsJson({ type: "csp-violation" }), []) // not an array
  const out = parseReportsJson([
    { type: "totally-made-up", body: {} },
    { type: "deprecation", body: { id: "x" } },
    { noType: true },
    "junk",
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].reportType, "deprecation")
})

test("parseReportsJson caps count at 100 and truncates oversized bodies", () => {
  const many = Array.from({ length: 250 }, () => ({
    type: "intervention",
    body: { id: "i" },
  }))
  assert.equal(parseReportsJson(many).length, 100)

  const big = parseReportsJson([
    { type: "crash", body: { reason: "x".repeat(20_000) } },
  ])
  assert.deepEqual(big[0].body, { truncated: true })
})

test("parseCspReport handles the legacy single-object hyphenated envelope", () => {
  const out = parseCspReport({
    "csp-report": {
      "document-uri": "https://site/page",
      "blocked-uri": "https://evil/x.css",
      "violated-directive": "style-src",
    },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].reportType, "csp-violation")
  assert.equal(out[0].url, "https://site/page")
  assert.equal(out[0].body["blocked-uri"], "https://evil/x.css")
})

test("parseCspReport rejects malformed / array / missing envelope", () => {
  assert.deepEqual(parseCspReport([{ "csp-report": {} }]), [])
  assert.deepEqual(parseCspReport({ notCsp: {} }), [])
  assert.deepEqual(parseCspReport("junk"), [])
})
