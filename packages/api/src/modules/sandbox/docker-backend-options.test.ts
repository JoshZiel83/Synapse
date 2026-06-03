// Unit tests for dockerBackendOptionsFromEnv — the docker sandbox backend's
// env→options builder. Pure env logic (no DB): asserts the fail-fast tunnel +
// FRP_SHARED_TOKEN contract added in round-3 (a docker sandbox is only reachable
// over frp, so tunnel MUST be frp and the shared token MUST be present).

import test from "node:test"
import assert from "node:assert/strict"
import { dockerBackendOptionsFromEnv } from "./service.js"

const REQUIRED = {
  SYNAPSE_SANDBOX_IMAGE: "img:test",
  SYNAPSE_SANDBOX_DOCKER_NETWORK: "net",
  SYNAPSE_SANDBOX_STORAGE_VOLUME: "vol",
  FRP_SHARED_TOKEN: "frp-tok",
}

const TUNNEL_KEYS = [
  "SYNAPSE_SANDBOX_IMAGE",
  "SYNAPSE_SANDBOX_DOCKER_NETWORK",
  "SYNAPSE_SANDBOX_STORAGE_VOLUME",
  "FRP_SHARED_TOKEN",
  "SYNAPSE_SANDBOX_TUNNEL",
  "SYNAPSE_SANDBOX_SERVER_ORIGIN",
  "SYNAPSE_DEVICE_TUNNEL_EDGE_URL",
  "SYNAPSE_TUNNEL_VHOST_HOST",
] as const

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T
): T {
  const prev: Record<string, string | undefined> = {}
  const keys = new Set([...TUNNEL_KEYS, ...Object.keys(overrides)])
  for (const k of keys) {
    prev[k] = process.env[k]
    const v = overrides[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]!
    }
  }
}

test("dockerBackendOptionsFromEnv: defaults tunnel to frp and carries the token", () => {
  withEnv({ ...REQUIRED, SYNAPSE_SANDBOX_TUNNEL: undefined }, () => {
    const opts = dockerBackendOptionsFromEnv()
    assert.equal(opts.tunnel, "frp")
    assert.equal(opts.tunnelAuthToken, "frp-tok")
    assert.equal(opts.image, "img:test")
  })
})

test("dockerBackendOptionsFromEnv: explicit tunnel=frp is accepted", () => {
  withEnv({ ...REQUIRED, SYNAPSE_SANDBOX_TUNNEL: "frp" }, () => {
    assert.equal(dockerBackendOptionsFromEnv().tunnel, "frp")
  })
})

test("dockerBackendOptionsFromEnv: tunnel=none fails fast (docker has no loopback path)", () => {
  withEnv({ ...REQUIRED, SYNAPSE_SANDBOX_TUNNEL: "none" }, () => {
    assert.throws(
      () => dockerBackendOptionsFromEnv(),
      /SYNAPSE_SANDBOX_TUNNEL must be 'frp'/
    )
  })
})

test("dockerBackendOptionsFromEnv: a bogus tunnel value fails fast", () => {
  withEnv({ ...REQUIRED, SYNAPSE_SANDBOX_TUNNEL: "wireguard" }, () => {
    assert.throws(
      () => dockerBackendOptionsFromEnv(),
      /SYNAPSE_SANDBOX_TUNNEL must be 'frp'/
    )
  })
})

test("dockerBackendOptionsFromEnv: missing FRP_SHARED_TOKEN fails fast", () => {
  withEnv(
    { ...REQUIRED, FRP_SHARED_TOKEN: undefined, SYNAPSE_SANDBOX_TUNNEL: "frp" },
    () => {
      assert.throws(
        () => dockerBackendOptionsFromEnv(),
        /FRP_SHARED_TOKEN is required/
      )
    }
  )
})

// ── R5 residual #2: edge URL host must agree with the frps vhost host.

test("dockerBackendOptionsFromEnv: defaults agree (no edge/vhost set → tunnel-edge)", () => {
  withEnv(
    {
      ...REQUIRED,
      SYNAPSE_DEVICE_TUNNEL_EDGE_URL: undefined,
      SYNAPSE_TUNNEL_VHOST_HOST: undefined,
    },
    () => {
      const opts = dockerBackendOptionsFromEnv()
      assert.equal(opts.tunnelVhostHost, undefined)
      assert.equal(opts.tunnelInternalBaseUrl, undefined)
    }
  )
})

test("dockerBackendOptionsFromEnv: matching custom edge host + vhost is accepted", () => {
  withEnv(
    {
      ...REQUIRED,
      SYNAPSE_DEVICE_TUNNEL_EDGE_URL: "https://edge.example.com:9443",
      SYNAPSE_TUNNEL_VHOST_HOST: "edge.example.com",
    },
    () => {
      const opts = dockerBackendOptionsFromEnv()
      assert.equal(opts.tunnelInternalBaseUrl, "https://edge.example.com:9443")
      assert.equal(opts.tunnelVhostHost, "edge.example.com")
    }
  )
})

test("dockerBackendOptionsFromEnv: edge host vs vhost mismatch fails fast", () => {
  withEnv(
    {
      ...REQUIRED,
      SYNAPSE_DEVICE_TUNNEL_EDGE_URL: "https://edge.example.com:9443",
      SYNAPSE_TUNNEL_VHOST_HOST: "some-other-host",
    },
    () => {
      assert.throws(
        () => dockerBackendOptionsFromEnv(),
        /must match SYNAPSE_TUNNEL_VHOST_HOST|routes by the vhost/
      )
    }
  )
})

test("dockerBackendOptionsFromEnv: custom edge with NO vhost set mismatches the tunnel-edge default", () => {
  // vhost defaults to 'tunnel-edge'; a custom edge host won't match it.
  withEnv(
    {
      ...REQUIRED,
      SYNAPSE_DEVICE_TUNNEL_EDGE_URL: "http://edge.example.com:8080",
      SYNAPSE_TUNNEL_VHOST_HOST: undefined,
    },
    () => {
      assert.throws(
        () => dockerBackendOptionsFromEnv(),
        /must match SYNAPSE_TUNNEL_VHOST_HOST/
      )
    }
  )
})

test("dockerBackendOptionsFromEnv: an unparseable edge URL fails fast", () => {
  withEnv(
    { ...REQUIRED, SYNAPSE_DEVICE_TUNNEL_EDGE_URL: "://not a url" },
    () => {
      assert.throws(() => dockerBackendOptionsFromEnv(), /not a valid URL/)
    }
  )
})
