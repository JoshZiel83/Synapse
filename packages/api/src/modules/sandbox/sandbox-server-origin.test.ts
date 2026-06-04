// Unit tests for the two pure spec-building helpers extracted from
// provisionSandbox: sandboxLocalServerOrigin (which origin the LOCAL device
// dials back to) and sandboxSpecVolumeSubpath (the docker-ONLY volume subpath).
// Both are pure env/arg logic (no DB), mirroring docker-backend-options.test.ts.

import test from "node:test"
import assert from "node:assert/strict"
import {
  sandboxLocalServerOrigin,
  sandboxSpecVolumeSubpath,
} from "./service.js"
import { config } from "../../config/index.js"

// Save/restore the one env var sandboxLocalServerOrigin reads, mirroring the
// withEnv harness in docker-backend-options.test.ts.
function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T
): T {
  const keys = Object.keys(overrides)
  const prev: Record<string, string | undefined> = {}
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

// ── B1: sandboxLocalServerOrigin ─────────────────────────────────────────────

test("sandboxLocalServerOrigin: honors SYNAPSE_SANDBOX_SERVER_ORIGIN when set", () => {
  withEnv({ SYNAPSE_SANDBOX_SERVER_ORIGIN: "http://127.0.0.1:3001" }, () => {
    assert.equal(sandboxLocalServerOrigin(), "http://127.0.0.1:3001")
  })
})

test("sandboxLocalServerOrigin: falls back to config.app.baseUrl when unset", () => {
  withEnv({ SYNAPSE_SANDBOX_SERVER_ORIGIN: undefined }, () => {
    // Compare against the same frozen const the helper falls back to (the value
    // is import-time-fixed, so this stays deterministic regardless of the env).
    assert.equal(sandboxLocalServerOrigin(), config.app.baseUrl)
  })
})

test("sandboxLocalServerOrigin: blank/whitespace value falls back (not used verbatim)", () => {
  withEnv({ SYNAPSE_SANDBOX_SERVER_ORIGIN: "   " }, () => {
    assert.equal(sandboxLocalServerOrigin(), config.app.baseUrl)
  })
})

// ── B2: sandboxSpecVolumeSubpath (the bare-metal-local regression) ───────────
// The bug: provisionSandbox computed this DOCKER-ONLY field unconditionally, and
// toSandboxVolumeSubpath throws when storageDir isn't under the mount point —
// which a bare-metal API (STORAGE_DIR=/tmp/synapse-storage) always trips. The
// fix: only compute for docker; local gets undefined.

const SESSION = "00000000-0000-4000-8000-000000000000"

test("sandboxSpecVolumeSubpath: local backend never computes it (no throw on bare-metal STORAGE_DIR)", () => {
  // Bare-metal default layout that WOULD throw if toSandboxVolumeSubpath ran.
  const out = sandboxSpecVolumeSubpath("local", {
    storageDir: "/tmp/synapse-storage",
    mountPoint: "/app/storage",
    sessionId: SESSION,
  })
  assert.equal(out, undefined)
})

test("sandboxSpecVolumeSubpath: docker backend computes the subpath under a valid layout", () => {
  const out = sandboxSpecVolumeSubpath("docker", {
    storageDir: "/app/storage/files",
    mountPoint: "/app/storage",
    sessionId: SESSION,
  })
  assert.equal(out, `files/sandboxes/${SESSION}`)
})

test("sandboxSpecVolumeSubpath: docker backend still fail-fasts on a misconfigured layout", () => {
  // The throw is correct for docker (a misconfigured mount would silently hide
  // the materialized files); only local was wrongly subjected to it before.
  assert.throws(
    () =>
      sandboxSpecVolumeSubpath("docker", {
        storageDir: "/tmp/synapse-storage",
        mountPoint: "/app/storage",
        sessionId: SESSION,
      }),
    /is not under the sandbox storage/
  )
})
