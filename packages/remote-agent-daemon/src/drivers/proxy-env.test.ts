import test from "node:test"
import assert from "node:assert/strict"
import { buildAgentChildEnv } from "./proxy-env.js"

test("buildAgentChildEnv returns empty when explicitly disabled", () => {
  assert.deepEqual(buildAgentChildEnv({ enabled: false }), {})
})

test("buildAgentChildEnv defaults to <redacted-outbound-proxy> with sane no_proxy", () => {
  const env = buildAgentChildEnv()
  assert.equal(env.HTTPS_PROXY, "<redacted-outbound-proxy>")
  assert.equal(env.HTTP_PROXY, "<redacted-outbound-proxy>")
  assert.equal(env.https_proxy, env.HTTPS_PROXY)
  assert.equal(env.http_proxy, env.HTTP_PROXY)
  assert.ok(env.NO_PROXY?.includes("127.0.0.1"))
  assert.ok(env.NO_PROXY?.includes("localhost"))
  assert.equal(env.no_proxy, env.NO_PROXY)
})

test("buildAgentChildEnv merges extraNoProxyHosts and dedupes", () => {
  const env = buildAgentChildEnv({
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

test("buildAgentChildEnv accepts a custom proxyUrl override", () => {
  const env = buildAgentChildEnv({
    proxyUrl: "socks5h://proxy.example:9050",
  })
  assert.equal(env.HTTPS_PROXY, "socks5h://proxy.example:9050")
  assert.equal(env.http_proxy, "socks5h://proxy.example:9050")
})
