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

// ── B1: sandboxLocalServerOrigin ─────────────────────────────────────────────
// The origin is now resolved once at boot into config.sandbox.serverOrigin
// (SANDBOX_SERVER_ORIGIN, else app.baseUrl); the helper is a thin read of that
// frozen value, so we assert the wiring rather than mutating env.

test("sandboxLocalServerOrigin: returns config.sandbox.serverOrigin", () => {
  assert.equal(sandboxLocalServerOrigin(), config.sandbox.serverOrigin)
})

test("sandboxLocalServerOrigin: falls back to app.baseUrl when SANDBOX_SERVER_ORIGIN is unset", () => {
  // In the test env SANDBOX_SERVER_ORIGIN is unset, so serverOrigin resolves to
  // the app base url — the frozen fallback the helper returns.
  assert.equal(sandboxLocalServerOrigin(), config.app.baseUrl)
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
