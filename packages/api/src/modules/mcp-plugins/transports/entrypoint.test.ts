import { test } from "node:test"
import assert from "node:assert/strict"
import {
  renderTemplate,
  resolveRemoteEntryPoint,
  redactUrlForLog,
  TemplateResolutionError,
  type TemplateContext,
} from "./entrypoint.js"
import { registerAuthSecretSerializer } from "./auth-serializers.js"

function ctx(
  config: Record<string, unknown>,
  runtime: Record<string, unknown> = {}
): TemplateContext {
  return { config, runtime }
}

test("config + env + runtime template sources resolve", () => {
  process.env.__ENTRYPOINT_TEST__ = "envval"
  const out = renderTemplate(
    "c=${config:a}/e=${env:__ENTRYPOINT_TEST__}/r=${runtime:installationId}",
    ctx({ a: "cfgval" }, { installationId: "inst-1" })
  )
  assert.equal(out, "c=cfgval/e=envval/r=inst-1")
  delete process.env.__ENTRYPOINT_TEST__
})

test("required template missing value throws (fail-closed)", () => {
  assert.throws(
    () => renderTemplate("Bearer ${config:apiKey}", ctx({})),
    TemplateResolutionError
  )
  assert.throws(
    () => renderTemplate("${env:__DEFINITELY_UNSET_VAR__}", ctx({})),
    TemplateResolutionError
  )
})

test("optional template (${source?:...}) allows empty", () => {
  assert.equal(renderTemplate("x=${config?:missing}", ctx({})), "x=")
  assert.equal(renderTemplate("x=${env?:__UNSET__}", ctx({})), "x=")
})

test("boolean false / number 0 are present values, not missing", () => {
  assert.equal(renderTemplate("${config:flag}", ctx({ flag: false })), "false")
  assert.equal(renderTemplate("${config:n}", ctx({ n: 0 })), "0")
})

test("dotted config path resolves nested values", () => {
  assert.equal(
    renderTemplate("${config:a.b.c}", ctx({ a: { b: { c: "deep" } } })),
    "deep"
  )
})

test("${auth:field.path} reads secretPayload and requires active status", () => {
  const active = ctx({
    figmaAccount: {
      status: "active",
      secretPayload: { accessToken: "tok123" },
    },
  })
  assert.equal(
    renderTemplate("Bearer ${auth:figmaAccount.accessToken}", active),
    "Bearer tok123"
  )

  const inactive = ctx({
    figmaAccount: {
      status: "expired",
      secretPayload: { accessToken: "stale" },
    },
  })
  assert.throws(
    () => renderTemplate("${auth:figmaAccount.accessToken}", inactive),
    TemplateResolutionError
  )
})

test("${auth_b64:field} base64-encodes the whole secretPayload (identity serializer)", () => {
  const out = renderTemplate(
    "${auth_b64:acct}",
    ctx({
      acct: {
        status: "active",
        driver: "no_serializer",
        secretPayload: { a: 1, b: "x" },
      },
    })
  )
  const decoded = JSON.parse(Buffer.from(out, "base64").toString("utf-8"))
  assert.deepEqual(decoded, { a: 1, b: "x" })
})

test("${auth_b64:field} applies a driver-registered serializer before encoding", () => {
  registerAuthSecretSerializer("test_driver", (secret) => ({
    mapped: secret.original,
  }))
  const out = renderTemplate(
    "${auth_b64:acct}",
    ctx({
      acct: {
        status: "active",
        driver: "test_driver",
        secretPayload: { original: "v" },
      },
    })
  )
  const decoded = JSON.parse(Buffer.from(out, "base64").toString("utf-8"))
  assert.deepEqual(decoded, { mapped: "v" })
})

test("resolveRemoteEntryPoint: query keys are URL-encoded via searchParams", () => {
  const r = resolveRemoteEntryPoint(
    JSON.stringify({
      url: "https://mcp.amap.com/mcp",
      query: { key: "${config:apiKey}" },
    }),
    ctx({ apiKey: "a b&c" }),
    "streamable-http"
  )
  // space + ampersand must be percent-encoded, not raw.
  assert.match(r.url, /key=a(\+|%20)b%26c/)
  assert.equal(r.protocol, "streamable-http")
  assert.deepEqual(r.headers, {})
})

test("resolveRemoteEntryPoint: headers templated; protocol honored", () => {
  const r = resolveRemoteEntryPoint(
    JSON.stringify({
      url: "https://mcp.aminer.cn/sse",
      headers: { Authorization: "Bearer ${config:apiKey}" },
      protocol: "sse",
    }),
    ctx({ apiKey: "tok" }),
    "streamable-http"
  )
  assert.equal(r.url, "https://mcp.aminer.cn/sse")
  assert.equal(r.headers.Authorization, "Bearer tok")
  assert.equal(r.protocol, "sse")
})

test("resolveRemoteEntryPoint: bare URL string + env templating", () => {
  process.env.__EP_URL__ = "http://mijia-mcp:8765/mcp"
  const r = resolveRemoteEntryPoint(
    "${env:__EP_URL__}",
    ctx({}),
    "streamable-http"
  )
  assert.equal(r.url, "http://mijia-mcp:8765/mcp")
  delete process.env.__EP_URL__
})

test("redactUrlForLog masks secret query params, leaves others", () => {
  assert.equal(
    redactUrlForLog("https://mcp.amap.com/mcp?key=SECRET&x=1"),
    "https://mcp.amap.com/mcp?key=***&x=1"
  )
  assert.equal(
    redactUrlForLog("https://example.com/mcp?token=abc&sig=z"),
    "https://example.com/mcp?token=***&sig=***"
  )
  // No secret params → unchanged.
  assert.equal(
    redactUrlForLog("https://example.com/mcp?x=1"),
    "https://example.com/mcp?x=1"
  )
})
