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

/**
 * Why a pending conflict sidecar could not be re-materialized on a provision.
 * Drives the agent notice wording (P3): a transient failure may self-heal, a
 * permanent one never will, so they must not make the same promise.
 */
export type SidecarRestoreFailureReason = "transient" | "permanent"

export interface SidecarRestoreFailure {
  /** Agent-visible sidecar VFS path that could not be re-materialized. */
  sidecar: string
  /**
   * "transient" = may succeed on a LATER provision — the preserved bytes are
   * safe (file bytes in CAS, symlink target recorded) but couldn't be written
   * this turn (no live mount for the subpath yet, or a transient fs error). The
   * notice may promise a retry.
   * "permanent" = the durable record itself LACKS the payload needed to rebuild
   * the sidecar (a pre-round-11 / corrupt record: no contentSha for a file, no
   * target for a symlink, or an unparseable sidecar path). It will NEVER restore;
   * the notice must NOT promise a retry.
   */
  reason: SidecarRestoreFailureReason
}

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
  /**
   * The pending conflict sidecars that could NOT be re-materialized this
   * provision, each tagged with WHY (P2/P3). The notice lists these WITHOUT a
   * "read it" instruction; "transient" ones promise a later-turn retry while
   * "permanent" ones (missing/corrupt payload) do not. Empty when
   * sidecarRestoreOk is true.
   */
  failedSidecars: SidecarRestoreFailure[]
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
