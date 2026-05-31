// bwrap command confinement for sandbox device-runtimes (Step 10).
//
// Wraps a SpawnDescriptor so the command runs inside a bubblewrap jail:
//   - no network (--unshare-net), own pid namespace, die-with-parent;
//   - the sandbox mount points bound to their in-container same-name paths
//     (/conversation, /actor, /actor-conversation) so a shell `cat /conversation/x`
//     reads the SAME bytes the VFS tools see (rootPath=<sandbox> maps
//     /conversation → <sandbox>/conversation);
//   - read-only system + toolchain binds so common tools run, but the host FS
//     outside the mounts is unreachable (no --bind <root>);
//   - default cwd = /conversation.
//
// This is the enforcement that makes the commandline:"sandbox" grant safe:
// isolation is the boundary, so the grant authorizes any command, and bwrap
// guarantees that "any command" can't escape the jail or reach the network.
// Linux-only — callers must not construct this on non-Linux (fail-closed).

import { existsSync } from "node:fs"
import type { SpawnDescriptor } from "./types.js"

export interface SandboxConfinement {
  /** Sandbox FS root; its children are the materialized mount points. */
  sandboxRoot: string
  /** Extra read-only host dirs to bind (toolchain bin dirs, resolved by caller). */
  readonlyBinds?: string[]
  /** In-container working directory (default /conversation). */
  cwd?: string
}

// The fixed mount points a sandbox device-runtime exposes (must match
// SANDBOX_MOUNT_POINTS in @synapse/shared and the materialized subdir names).
const MOUNT_SUBPATHS = ["conversation", "actor", "actor-conversation"] as const

// Standard read-only system paths a command typically needs. Each is bound only
// if it exists on the host (slim images vary).
const SYSTEM_RO_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc/alternatives",
  "/etc/ssl",
  "/etc/ca-certificates",
]

export const DEFAULT_SANDBOX_CWD = "/conversation"

// Absolute bwrap path candidates, in preference order. We spawn bwrap by its
// absolute path (never a bare "bwrap" resolved via the child PATH, which is
// prepended with toolchain bin dirs) so the confining binary itself can't be
// shadowed by a toolchain/earlier-PATH executable named "bwrap" — that would
// run the agent's command unconfined on the host (fail-open).
const BWRAP_PATHS = ["/usr/bin/bwrap", "/bin/bwrap"] as const

/** The absolute path to bwrap, or null if not found. */
export function resolveBwrapPath(): string | null {
  for (const p of BWRAP_PATHS) {
    if (existsSync(p)) return p
  }
  return null
}

/** Probe whether bwrap is invocable (caller should also gate on platform). */
export function bwrapAvailable(): boolean {
  return process.platform === "linux" && resolveBwrapPath() !== null
}

/**
 * Build the bwrap argument vector (everything up to and including `--`) for a
 * sandbox confinement. Exposed for testing the arg construction without
 * spawning. The order matters: ro-binds before the writable mount binds so a
 * writable mount can't be shadowed by a broad ro-bind.
 */
export function buildBwrapArgs(confinement: SandboxConfinement): string[] {
  const args: string[] = [
    "--unshare-net", // no network
    "--unshare-pid", // own pid namespace
    "--unshare-uts",
    "--unshare-ipc",
    "--die-with-parent", // bwrap exits if the device-runtime dies
    "--new-session", // detach from controlling tty (no TIOCSTI escape)
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ]

  // Read-only system + toolchain binds (only those that exist).
  for (const p of SYSTEM_RO_PATHS) {
    if (existsSync(p)) {
      args.push("--ro-bind", p, p)
    }
  }
  for (const p of confinement.readonlyBinds ?? []) {
    if (existsSync(p)) {
      args.push("--ro-bind", p, p)
    }
  }

  // Writable mount-point binds: <sandbox>/<subpath> → /<subpath>. This aligns
  // with the VFS rootPath=<sandbox> mapping so both views are the same bytes.
  for (const subpath of MOUNT_SUBPATHS) {
    const host = `${confinement.sandboxRoot}/${subpath}`
    if (existsSync(host)) {
      args.push("--bind", host, `/${subpath}`)
    }
  }

  // Default cwd inside the jail.
  args.push("--chdir", confinement.cwd ?? DEFAULT_SANDBOX_CWD)

  args.push("--") // end of bwrap options; the command follows
  return args
}

/**
 * Wrap a SpawnDescriptor to run under bwrap confinement. The original program +
 * args become bwrap's trailing command. stdio is preserved.
 *
 * NOTE: the resolved program path must be reachable inside the jail. Because we
 * ro-bind /usr, /bin, etc., absolute program paths under those trees resolve;
 * bundled-toolchain programs require their bin dir to be in `readonlyBinds`.
 */
export function wrapDescriptorWithBwrap(
  descriptor: SpawnDescriptor,
  confinement: SandboxConfinement
): SpawnDescriptor {
  const bwrapPath = resolveBwrapPath()
  if (!bwrapPath) {
    // Caller must gate on bwrapAvailable() first; this is a defense-in-depth
    // guard so we never silently fall back to an unconfined bare-name spawn.
    throw new Error("bwrap not found; refusing to build a confined descriptor")
  }
  const bwrapArgs = buildBwrapArgs(confinement)
  return {
    program: bwrapPath,
    args: [...bwrapArgs, descriptor.program, ...descriptor.args],
    stdio: descriptor.stdio,
  }
}
