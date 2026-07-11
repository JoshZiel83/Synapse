// Host provider: spawns the per-session device-runtime as a same-host child
// process (topology A). Abstracted behind an interface so the provision logic
// can be unit-tested with a stub, and so a future e2b/remote provider can slot
// in without touching the sandbox service.
//
// The local provider only spawns the long-lived runtime daemon:
//   `synapse-device run --broker-dir <session-dir> --fs-root <sandbox> ...` —
//   blocks until SIGTERM, advertising the filesystem + commandline builtins over
//   device.catalog.sync. The session-private broker dir (device-identity.json +
//   ed25519 keys) is written up front by the local backend's direct-mint (§4.6),
//   NOT by a pairing round-trip — so there is no `pair` step here.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { casDir } from "./materialize.js"
import { config } from "../../config/index.js"
import type { BackendId } from "../../infrastructure/storage/content-store.js"

/**
 * How a sandbox host gets at blob bytes (plan §8.3, the materialize/commit seam).
 *
 *  - `local_cas`: SAME-HOST (axis A). The supervisor and the device-runtime share
 *    one CAS volume (`casDir` = the shared cache root), so the supervisor fills/drains
 *    that shared cache directly and the (unchanged) helper reflinks from it. This
 *    is the DEFAULT and its behavior is byte-identical to today.
 *  - `presigned`: REMOTE, untrusted host (axis B). The host holds NO long-term
 *    credentials; it streams bytes itself over supervisor-minted, short-lived,
 *    single-object presigned URLs (`backend` = the durable backend to mint
 *    against; `allowHost` = the SSRF allowlist host the helper is pinned to).
 */
export type BlobAccess =
  | { kind: "local_cas"; casDir: string }
  | { kind: "presigned"; backend: BackendId; allowHost: string }

export class HostProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HostProviderError"
  }
}

export interface RunHandle {
  /** OS pid of the device-runtime daemon (for teardown SIGTERM/SIGKILL). */
  pid: number
  /** SIGTERM then (after a grace period) SIGKILL the daemon. */
  stop(): Promise<void>
}

export interface SpawnSandboxRuntimeParams {
  /** Session-private broker dir (device-identity.json + keys). */
  brokerDir: string
  /** The sandbox FS root (its children are the materialized mount points). */
  fsRoot: string
  /** Absolute synapse-device-fs-helper path (passed to `run --fs-helper`). */
  fsHelperPath: string
  /** API origin the device connects back to (e.g. http://localhost:3001). */
  serverOrigin: string
  /** Enable the delete tool (default true for a sandbox). */
  enableDelete?: boolean
  /**
   * Confine every commandline invocation in a bwrap jail (--cmd-sandbox). Set
   * when the host supports bwrap; when false the device exposes no confined
   * commandline (fail-closed — the platform also withholds the commandline grant).
   */
  confineCommands?: boolean
  /** Human title for the paired device. */
  title?: string
}

export interface HostProvider {
  /** Run `synapse-device run` as a daemon; resolves once it's spawned. */
  run(params: SpawnSandboxRuntimeParams): Promise<RunHandle>
  /**
   * How this host reaches blob bytes (plan §8.3). The local provider is same-host
   * (`local_cas`); a future e2b/remote provider returns `presigned`. The sandbox
   * materialize/commit path branches on this to pick axis A (supervisor copy) vs
   * axis B (host direct presigned transfer).
   */
  blobAccess(): BlobAccess
}

const KILL_GRACE_MS = 2_000

/** Resolve the synapse-device CLI entry (dist/bin.js). */
function resolveDeviceCliPath(): string {
  const fromConfig = config.sandbox.local.cliPath
  if (fromConfig && existsSync(fromConfig)) return fromConfig
  const here = fileURLToPath(import.meta.url)
  // Probe the device-runtime dist relative to api's dist/src + node_modules link.
  const candidates = [
    resolve(
      here,
      "..",
      "..",
      "..",
      "..",
      "..",
      "device-runtime",
      "dist",
      "bin.js"
    ),
    resolve(
      here,
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "packages",
      "device-runtime",
      "dist",
      "bin.js"
    ),
    resolve(
      here,
      "..",
      "..",
      "..",
      "..",
      "node_modules",
      "@synapse",
      "device-runtime",
      "dist",
      "bin.js"
    ),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new HostProviderError(
    "synapse-device CLI (dist/bin.js) not found (build device-runtime or set SYNAPSE_DEVICE_CLI_PATH)"
  )
}

/**
 * Default local provider: spawns the device-runtime CLI as child processes.
 * Uses --flag=value form (cli-args.ts tolerates value-swallowing only for the
 * bare/last-token case, so explicit = is safest).
 */
export function createLocalHostProvider(opts?: {
  cliPath?: string
  spawnImpl?: typeof spawn
}): HostProvider {
  const cliPath = opts?.cliPath ?? resolveDeviceCliPath()
  const spawnImpl = opts?.spawnImpl ?? spawn

  return {
    blobAccess(): BlobAccess {
      // Same-host (axis A): the API supervisor and the device-runtime share the
      // one CAS volume, so the supervisor fills/drains it directly and the helper
      // reflinks from it. `casDir()` is the shared cache root the one-shot helper
      // is pointed at (materialize.ts), so BlobAccess.casDir matches exactly what
      // the helper uses.
      return { kind: "local_cas", casDir: casDir() }
    },

    async run(params: SpawnSandboxRuntimeParams): Promise<RunHandle> {
      const args = [
        cliPath,
        "run",
        `--broker-dir=${params.brokerDir}`,
        `--fs-root=${params.fsRoot}`,
        `--fs-helper=${params.fsHelperPath}`,
        "--fs-enable-write",
        ...(params.enableDelete === false ? [] : ["--fs-enable-delete"]),
        ...(params.confineCommands ? ["--cmd-sandbox"] : []),
        // The sandbox uses the Postgres snapshot DAG, not the helper's legacy
        // per-write history. Disable history but keep write tools visible.
        "--fs-disable-history",
        "--fs-allow-unversioned-write",
        // The local backend's runtime is a same-host child of the API, so it
        // exposes its MCP host over a direct loopback URL (no frpc). The server
        // accepts this loopback endpoint only for live local sandboxes (see the
        // local-sandbox branch in validateTunnelInternalUrl). Without an
        // explicit tunnel mode the runtime would register NO endpoint and every
        // sandbox tool dispatch would fail with no_tunnel_endpoint.
        "--tunnel-mode=noop",
        `--server=${params.serverOrigin}`,
      ]
      const child = spawnImpl(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      })

      // The daemon is long-lived; a ChildProcess that emits 'error' with no
      // listener throws as an uncaughtException and would take down the whole
      // API process. Always keep a listener attached: during startup it feeds
      // the early-failure rejection below; afterwards it logs.
      let settled = false
      let earlyStderr = ""
      child.stderr?.on("data", (d) => {
        if (!settled) earlyStderr += d.toString()
      })
      const onError = (err: Error) => {
        if (settled) {
          console.error("[sandbox] device-runtime daemon error:", err)
        }
      }
      const onExit = (code: number | null) => {
        if (settled) {
          console.error(
            `[sandbox] device-runtime daemon exited unexpectedly (code=${code ?? "null"})`
          )
        }
      }
      child.on("error", onError)
      child.on("exit", onExit)

      // Race the spawn against early death: if the daemon dies (bad broker-dir,
      // missing identity, startup throw) within a short window, fail loudly with
      // the real stderr instead of returning a dead pid that only surfaces as a
      // misleading 30s catalog-sync timeout downstream.
      await new Promise<void>((resolvePromise, reject) => {
        const STARTUP_WINDOW_MS = 800
        const timer = setTimeout(() => {
          settled = true
          resolvePromise()
        }, STARTUP_WINDOW_MS)
        child.once("error", (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(
            new HostProviderError(
              `synapse-device run failed to spawn: ${err.message}`
            )
          )
        })
        child.once("exit", (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(
            new HostProviderError(
              `synapse-device run exited ${code} during startup: ${earlyStderr.slice(0, 300)}`
            )
          )
        })
      })

      if (typeof child.pid !== "number") {
        throw new HostProviderError(
          "failed to spawn synapse-device run (no pid)"
        )
      }
      const pid = child.pid
      return {
        pid,
        stop: () => stopChild(child),
      }
    },
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      resolvePromise()
    }, KILL_GRACE_MS)
    child.once("exit", () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

export { resolveDeviceCliPath }
