import test from "node:test"
import assert from "node:assert/strict"
import { buildAgentChildEnv } from "./proxy-env.js"

const EXAMPLE_PROXY = "http://proxy.example.invalid:8080"

test("buildAgentChildEnv returns empty when no proxyUrl is configured", () => {
  // No silent default — daemons not on a tunnel host would dead-route
  // every claude / codex API call if we shipped one.
  assert.deepEqual(buildAgentChildEnv(), {})
  assert.deepEqual(buildAgentChildEnv({}), {})
  assert.deepEqual(buildAgentChildEnv({ proxyUrl: "" }), {})
  assert.deepEqual(buildAgentChildEnv({ proxyUrl: "   " }), {})
})

test("buildAgentChildEnv injects every env-var case when proxyUrl is set", () => {
  const env = buildAgentChildEnv({
    proxyUrl: EXAMPLE_PROXY,
  })
  assert.equal(env.HTTPS_PROXY, EXAMPLE_PROXY)
  assert.equal(env.HTTP_PROXY, EXAMPLE_PROXY)
  assert.equal(env.https_proxy, env.HTTPS_PROXY)
  assert.equal(env.http_proxy, env.HTTP_PROXY)
  assert.ok(env.NO_PROXY?.includes("127.0.0.1"))
  assert.ok(env.NO_PROXY?.includes("localhost"))
  assert.equal(env.no_proxy, env.NO_PROXY)
})

test("buildAgentChildEnv merges extraNoProxyHosts and dedupes", () => {
  const env = buildAgentChildEnv({
    proxyUrl: EXAMPLE_PROXY,
    extraNoProxyHosts: ["host.docker.internal", "127.0.0.1", "rae-api"],
  })
  const list = (env.NO_PROXY ?? "").split(",")
  assert.ok(list.includes("host.docker.internal"))
  assert.ok(list.includes("rae-api"))
  assert.equal(
    list.filter((host) => host === "127.0.0.1").length,
    1,
    "no duplicate entries"
  )
})
