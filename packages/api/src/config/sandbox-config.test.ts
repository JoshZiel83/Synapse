// Unit tests for the P2 sandbox config fold (§8.2): the SANDBOX_PROVIDER /
// SANDBOX_MODE resolution + the docker boot-reject gate that replaced the old
// dockerBackendOptionsFromEnv fail-fast (ex docker-backend-options.test.ts).
//
// These drive envSchema.safeParse + the resolvers directly (config itself is a
// module singleton frozen at import, so it can't be re-evaluated per test).

import test from "node:test"
import assert from "node:assert/strict"
import {
  envSchema,
  resolveSandboxProviderName,
  resolveSandboxMode,
} from "./index.js"

const BASE = { NODE_ENV: "test" as const }

// docker:bare fs ops are host-side, so the superRefine requires the container uid
// to equal the API process uid. Match the test runner's own uid so the Mode-B
// accept case is CI-uid-agnostic (root vs unprivileged).
const RUNNER_UID = String(
  typeof process.getuid === "function" ? process.getuid() : 0
)

function parse(bag: Record<string, string>) {
  return envSchema.safeParse({ ...BASE, ...bag })
}

test("SANDBOX_PROVIDER=local + unset SANDBOX_MODE ⇒ resident (enabled)", () => {
  const parsed = parse({ SANDBOX_PROVIDER: "local" })
  assert.ok(parsed.success, "local provider parses")
  assert.equal(resolveSandboxProviderName(parsed.data), "local")
  assert.equal(resolveSandboxMode(parsed.data), "resident")
})

test("SANDBOX_PROVIDER=docker + full config + unset SANDBOX_MODE ⇒ resident (enabled)", () => {
  const parsed = parse({
    SANDBOX_PROVIDER: "docker",
    SANDBOX_DOCKER_IMAGE: "img:test",
    SANDBOX_DOCKER_NETWORK: "net",
    SANDBOX_DOCKER_STORAGE_VOLUME: "vol",
    FRP_SHARED_TOKEN: "frp-tok",
  })
  assert.ok(parsed.success, "docker with full config parses")
  assert.equal(resolveSandboxProviderName(parsed.data), "docker")
  assert.equal(resolveSandboxMode(parsed.data), "resident")
})

test("SANDBOX_PROVIDER unset ⇒ none (disabled)", () => {
  const parsed = parse({})
  assert.ok(parsed.success)
  assert.equal(resolveSandboxProviderName(parsed.data), "none")
})

test("SANDBOX_PROVIDER=none ⇒ none (disabled)", () => {
  const parsed = parse({ SANDBOX_PROVIDER: "none" })
  assert.ok(parsed.success)
  assert.equal(resolveSandboxProviderName(parsed.data), "none")
})

test("SANDBOX_PROVIDER=docker without image/network/volume/frp ⇒ boot reject", () => {
  const parsed = parse({ SANDBOX_PROVIDER: "docker" })
  assert.ok(!parsed.success, "bare docker must fail boot validation")
  const paths = parsed.success
    ? []
    : parsed.error.issues.map((i) => i.path.join("."))
  assert.ok(paths.includes("SANDBOX_DOCKER_IMAGE"))
  assert.ok(paths.includes("SANDBOX_DOCKER_NETWORK"))
  assert.ok(paths.includes("SANDBOX_DOCKER_STORAGE_VOLUME"))
  assert.ok(paths.includes("FRP_SHARED_TOKEN"))
})

test("SANDBOX_PROVIDER=docker with image/network/volume but no FRP_SHARED_TOKEN ⇒ reject (resident rides frp)", () => {
  const parsed = parse({
    SANDBOX_PROVIDER: "docker",
    SANDBOX_DOCKER_IMAGE: "img:test",
    SANDBOX_DOCKER_NETWORK: "net",
    SANDBOX_DOCKER_STORAGE_VOLUME: "vol",
  })
  assert.ok(!parsed.success)
  const paths = parsed.success
    ? []
    : parsed.error.issues.map((i) => i.path.join("."))
  assert.ok(paths.includes("FRP_SHARED_TOKEN"))
})

test("SANDBOX_PROVIDER=docker edge host vs vhost mismatch ⇒ reject", () => {
  const parsed = parse({
    SANDBOX_PROVIDER: "docker",
    SANDBOX_DOCKER_IMAGE: "img:test",
    SANDBOX_DOCKER_NETWORK: "net",
    SANDBOX_DOCKER_STORAGE_VOLUME: "vol",
    FRP_SHARED_TOKEN: "frp-tok",
    SYNAPSE_DEVICE_TUNNEL_EDGE_URL: "https://edge.example.com:9443",
    SYNAPSE_TUNNEL_VHOST_HOST: "some-other-host",
  })
  assert.ok(!parsed.success)
  const messages = parsed.success
    ? []
    : parsed.error.issues.map((i) => i.message)
  assert.ok(
    messages.some((m) => /must match SYNAPSE_TUNNEL_VHOST_HOST/.test(m))
  )
})

test("SANDBOX_PROVIDER=docker matching custom edge host + vhost ⇒ accepted", () => {
  const parsed = parse({
    SANDBOX_PROVIDER: "docker",
    SANDBOX_DOCKER_IMAGE: "img:test",
    SANDBOX_DOCKER_NETWORK: "net",
    SANDBOX_DOCKER_STORAGE_VOLUME: "vol",
    FRP_SHARED_TOKEN: "frp-tok",
    SYNAPSE_DEVICE_TUNNEL_EDGE_URL: "https://edge.example.com:9443",
    SYNAPSE_TUNNEL_VHOST_HOST: "edge.example.com",
  })
  assert.ok(parsed.success, "matching edge + vhost accepted")
})

test("SANDBOX_PROVIDER=docker + SANDBOX_MODE=bare with STORAGE_VOLUME + BARE_IMAGE but no IMAGE/NETWORK/FRP ⇒ accepted (Mode-B / docker:bare)", () => {
  const parsed = parse({
    SANDBOX_PROVIDER: "docker",
    SANDBOX_MODE: "bare",
    SANDBOX_DOCKER_STORAGE_VOLUME: "vol",
    SANDBOX_DOCKER_BARE_IMAGE: "debian:bookworm-slim",
    // Match the runner uid so the host-side uid-parity gate passes everywhere.
    SANDBOX_DOCKER_RUN_AS_UID: RUNNER_UID,
  })
  assert.ok(
    parsed.success,
    `docker:bare should parse with only STORAGE_VOLUME + BARE_IMAGE (IMAGE/NETWORK/FRP are resident-only); issues: ${
      parsed.success ? "" : JSON.stringify(parsed.error.issues)
    }`
  )
  assert.equal(
    resolveSandboxMode({ SANDBOX_PROVIDER: "docker", SANDBOX_MODE: "bare" }),
    "bare"
  )
})

test("SANDBOX_PROVIDER=docker + SANDBOX_MODE=resident without IMAGE ⇒ reject (IMAGE still required in resident mode)", () => {
  const parsed = parse({
    SANDBOX_PROVIDER: "docker",
    SANDBOX_MODE: "resident",
    SANDBOX_DOCKER_NETWORK: "net",
    SANDBOX_DOCKER_STORAGE_VOLUME: "vol",
    FRP_SHARED_TOKEN: "frp-tok",
  })
  assert.ok(!parsed.success, "resident docker without IMAGE must fail boot")
  const paths = parsed.success
    ? []
    : parsed.error.issues.map((i) => i.path.join("."))
  assert.ok(paths.includes("SANDBOX_DOCKER_IMAGE"))
})

test("SANDBOX_DOCKER_RUN_AS_UID permits 0 (root, today's default)", () => {
  const parsed = parse({ SANDBOX_DOCKER_RUN_AS_UID: "0" })
  assert.ok(parsed.success)
  assert.equal(parsed.data.SANDBOX_DOCKER_RUN_AS_UID, 0)
})

test("resolveSandboxMode: cubesandbox is the only bare-forcing provider; explicit mode wins", () => {
  // cubesandbox (the off-box adapter) is the ONLY provider that derives mode=bare.
  assert.equal(resolveSandboxMode({ SANDBOX_PROVIDER: "cubesandbox" }), "bare")
  // #9(1): the decommissioned e2b/cube names are no longer special-cased — they
  // resolve to 'resident' (an unregistered `${provider}:resident` key), which the
  // boot superRefine then hard-rejects. No lingering bare-forcing aliases.
  assert.equal(resolveSandboxMode({ SANDBOX_PROVIDER: "e2b" }), "resident")
  assert.equal(resolveSandboxMode({ SANDBOX_PROVIDER: "cube" }), "resident")
  // An explicit SANDBOX_MODE always wins over the provider-derived default.
  assert.equal(
    resolveSandboxMode({
      SANDBOX_PROVIDER: "cubesandbox",
      SANDBOX_MODE: "resident",
    }),
    "resident"
  )
  assert.equal(
    resolveSandboxMode({ SANDBOX_PROVIDER: "local", SANDBOX_MODE: "bare" }),
    "bare"
  )
})
