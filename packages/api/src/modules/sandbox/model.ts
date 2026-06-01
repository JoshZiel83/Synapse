// Shared types + capability probes for the sandbox manager.

import { execFileSync } from "node:child_process"

/**
 * Conflict-sidecar path prefix WITHIN a mount. On a refresh conflict, dir_sync
 * preserves the agent's pre-conflict local FILE version at
 * `<mountRoot>/.synapse-conflicts/<relpath>`. As an agent-visible VFS path that
 * is `/<mount-subpath>/.synapse-conflicts/<relpath>` — NOT a root-level
 * `/.synapse-conflicts/...` (which isn't a granted mount). Must match
 * CONFLICTS_DIRNAME in sidecars/fs-helper/src/manifest.rs.
 */
export const CONFLICT_SIDECAR_PREFIX = "/.synapse-conflicts"

export interface SandboxProvisionResult {
  sessionId: string
  /** The sandbox FS root; its children are the materialized mount points. */
  sandboxRoot: string
  deviceId: string
  /** Whether the commandline (bwrap-confined) tool was authorized. */
  commandlineEnabled: boolean
  mountIds: string[]
  /**
   * Whether every durable pending conflict sidecar was successfully
   * re-materialized into the fresh live dirs (round-11 #1 / R12-3). false = at
   * least one sidecar could not be restored; the caller must NOT clear the
   * pending store after actorThink (keep it retryable next provision) and should
   * not promise the agent it can read that sidecar.
   */
  sidecarRestoreOk: boolean
}

let cachedSandboxCommandlineAvailable: boolean | null = null

/**
 * Whether the host can run bwrap-confined commands (Linux + bwrap binary +
 * user namespaces). When false the sandbox is provisioned fail-closed: only the
 * filesystem tools (which carry their own VFS root jail) are authorized — the
 * commandline capability + grant are never created, so an unconfined shell can
 * never reach the host.
 *
 * Probed once and cached: a `bwrap --version` that succeeds proves the binary
 * exists and basic userns setup works enough to exec it. We deliberately keep
 * the probe cheap; the real confinement flags are applied at spawn time (Step
 * 10) and a spawn failure there is also fail-closed.
 */
export function isSandboxCommandlineAvailable(): boolean {
  if (cachedSandboxCommandlineAvailable !== null) {
    return cachedSandboxCommandlineAvailable
  }
  if (process.platform !== "linux") {
    cachedSandboxCommandlineAvailable = false
    return false
  }
  try {
    execFileSync("bwrap", ["--version"], { stdio: "ignore" })
    cachedSandboxCommandlineAvailable = true
  } catch {
    cachedSandboxCommandlineAvailable = false
  }
  return cachedSandboxCommandlineAvailable
}

/** Test seam: override/reset the cached bwrap probe. */
export function __setSandboxCommandlineAvailableForTest(
  value: boolean | null
): void {
  cachedSandboxCommandlineAvailable = value
}
