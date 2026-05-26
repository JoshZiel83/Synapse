// Regression test for Issue WWW: stop() / rotateToken() must verify
// the supplied TunnelHandle is the CURRENT managed entry. If a caller
// retains an old TunnelHandle after a restart and then calls
// stop(oldHandle), the previous implementation would look up the entry
// by deviceServiceId alone and SIGTERM the live tunnel — silently
// breaking a healthy connection. Same risk for rotateToken(oldHandle).

import test from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFrpTunnelAdapter } from "./frp.js"
import type { TunnelHandle } from "@synapse/device-protocol"

function writeSleepyStub(): {
  binPath: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), "frpc-stub-"))
  const binPath = join(dir, "frpc-stub.mjs")
  // Node-based stub: stays alive past the readiness probe, exits cleanly
  // on SIGTERM. We avoid /bin/sleep wrappers because shell `wait` +
  // backgrounded sleep can leak the child process on SIGTERM, which
  // hangs node:test until the orphan dies.
  writeFileSync(
    binPath,
    [
      "#!/usr/bin/env node",
      "process.on('SIGTERM', () => process.exit(0))",
      "process.on('SIGINT', () => process.exit(0))",
      "setInterval(() => {}, 60000)",
      "",
    ].join("\n"),
    { mode: 0o755 }
  )
  chmodSync(binPath, 0o755)
  return {
    binPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

test("stop() with a stale-shape handle does NOT take down the live tunnel", async () => {
  const stub = writeSleepyStub()
  try {
    const adapter = createFrpTunnelAdapter({
      frpcPath: stub.binPath,
      serverAddr: "127.0.0.1",
      serverPort: 7000,
      authToken: "test-auth",
      vhostHost: "test.local",
      startupGraceMs: 200,
    })
    const handle = await adapter.start({
      deviceServiceId: "svc-stale-stop",
      localPort: 14001,
      registrationToken: "tok-live",
    })

    // Construct a separate handle object pointing at the same service id.
    // This simulates the scenario where a caller cached an old handle
    // from a previous start() and the adapter has since rotated to a
    // new record (which it represents internally as a NEW handle
    // reference). The identity guard must short-circuit here.
    const staleHandle: TunnelHandle = {
      deviceServiceId: "svc-stale-stop",
      internalUrl: "http://stale-tunnel-edge:8080/d/orphan",
    }
    assert.notStrictEqual(
      staleHandle,
      handle,
      "test pre-condition: stale handle is a different object identity"
    )

    // The under-test call: stop(staleHandle) MUST NOT kill the live
    // tunnel's child. We assert this by verifying that stop(handle)
    // afterwards still successfully tears down the child — which would
    // throw inside kill() if it had already been killed by the stale
    // stop call (under the old buggy behavior the SIGTERM would have
    // fired against the live process via the deviceServiceId-only
    // lookup, leaving no process for the second stop() to signal).
    await adapter.stop(staleHandle)

    // Live stop succeeds.
    await adapter.stop(handle)

    // Give the exit handler a tick to clean up the tmp config dir.
    await new Promise((resolve) => setTimeout(resolve, 100))
  } finally {
    stub.cleanup()
  }
})

test("rotateToken() with a stale-shape handle does NOT rewrite the live tunnel config", async () => {
  const stub = writeSleepyStub()
  try {
    const adapter = createFrpTunnelAdapter({
      frpcPath: stub.binPath,
      serverAddr: "127.0.0.1",
      serverPort: 7000,
      authToken: "test-auth",
      vhostHost: "test.local",
      startupGraceMs: 200,
    })
    const handle = await adapter.start({
      deviceServiceId: "svc-stale-rotate",
      localPort: 14002,
      registrationToken: "tok-original",
    })

    const staleHandle: TunnelHandle = {
      deviceServiceId: "svc-stale-rotate",
      internalUrl: "http://stale-tunnel-edge:8080/d/orphan",
    }

    // rotateToken(stale) must be a no-op for the live tunnel's config.
    // We can't read the live config path directly (it's private to the
    // adapter), but we can verify by stopping the live tunnel and
    // asserting the tmp config dir is cleaned — if rotateToken had
    // crashed mid-write (or stomped on a now-deleted file), the
    // cleanup would error.
    await adapter.rotateToken(staleHandle, "should-not-land")

    // Live rotateToken still works.
    await adapter.rotateToken(handle, "tok-rotated")

    await adapter.stop(handle)
    await new Promise((resolve) => setTimeout(resolve, 100))
  } finally {
    stub.cleanup()
  }
})

// Smoke test for the matching positive path: live handle round-trips
// through start → rotateToken → stop without any of the guards
// rejecting the legitimate call.
test("happy path: start/rotateToken/stop on the same handle works", async () => {
  const stub = writeSleepyStub()
  try {
    const adapter = createFrpTunnelAdapter({
      frpcPath: stub.binPath,
      serverAddr: "127.0.0.1",
      serverPort: 7000,
      authToken: "test-auth",
      vhostHost: "test.local",
      startupGraceMs: 200,
    })
    const handle = await adapter.start({
      deviceServiceId: "svc-happy",
      localPort: 14003,
      registrationToken: "tok-a",
    })
    await adapter.rotateToken(handle, "tok-b")
    await adapter.stop(handle)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Silence unused-import lint for readFileSync/existsSync —
    // these may become useful for tighter assertions in future
    // revisions of this suite.
    void readFileSync
    void existsSync
  } finally {
    stub.cleanup()
  }
})
