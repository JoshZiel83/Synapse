// Host provider: spawns the per-session device-runtime as a same-host child
// process (topology A). Abstracted behind an interface so the provision logic
// can be unit-tested with a stub, and so a future e2b/remote provider can slot
// in without touching the sandbox service.
//
// The local provider runs the two-step local pairing:
//   1. `synapse-device pair --code <code> --broker-dir <session-dir>` — claims
//      the pairing session, writes device-identity.json + ed25519 keys into the
//      session-private broker dir (NEVER the shared default — broker.ts:27 would
//      let concurrent sessions clobber each other's identity).
//   2. `synapse-device run --broker-dir <session-dir> --fs-root <sandbox> ...` —
//      a long-lived daemon (blocks until SIGTERM) advertising the filesystem +
//      commandline builtins over device.catalog.sync.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export class HostProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HostProviderError"
  }
}

export interface PairResult {
  deviceId: string
  serviceId: string
  controlPlaneUrl?: string
}

export interface RunHandle {
  /** OS pid of the device-runtime daemon (for teardown SIGTERM/SIGKILL). */
  pid: number
  /** SIGTERM then (after a grace period) SIGKILL the daemon. */
  stop(): Promise<void>
}

export interface SpawnSandboxRuntimeParams {
  /** Pairing code from startPairing(mode=local_qr). */
  pairingCode: string
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
  /** Human title for the paired device. */
  title?: string
}

export interface HostProvider {
  /** Run `synapse-device pair`; resolves with the new device/service ids. */
  pair(params: SpawnSandboxRuntimeParams): Promise<PairResult>
  /** Run `synapse-device run` as a daemon; resolves once it's spawned. */
  run(params: SpawnSandboxRuntimeParams): Promise<RunHandle>
}

const KILL_GRACE_MS = 2_000

/** Resolve the synapse-device CLI entry (dist/bin.js). */
function resolveDeviceCliPath(): string {
  const fromEnv = process.env.SYNAPSE_DEVICE_CLI_PATH?.trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv
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
    async pair(params: SpawnSandboxRuntimeParams): Promise<PairResult> {
      const args = [
        cliPath,
        "pair",
        `--code=${params.pairingCode}`,
        `--broker-dir=${params.brokerDir}`,
        `--server=${params.serverOrigin}`,
        `--title=${params.title ?? "Sandbox"}`,
      ]
      const { stdout } = await runToCompletion(spawnImpl, args)
      // pair() prints the PairResult JSON (device_id, service_id, control_plane_url).
      const parsed = parsePairOutput(stdout)
      if (!parsed) {
        throw new HostProviderError(
          `synapse-device pair produced no parseable result: ${stdout.slice(0, 200)}`
        )
      }
      return parsed
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
        // The sandbox uses the Postgres snapshot DAG, not the helper's legacy
        // per-write history. Disable history but keep write tools visible.
        "--fs-disable-history",
        "--fs-allow-unversioned-write",
        `--server=${params.serverOrigin}`,
      ]
      const child = spawnImpl(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      })
      if (typeof child.pid !== "number") {
        throw new HostProviderError(
          "failed to spawn synapse-device run (no pid)"
        )
      }
      // Surface early spawn errors (binary missing, etc.).
      const pid = child.pid
      return {
        pid,
        stop: () => stopChild(child),
      }
    },
  }
}

function runToCompletion(
  spawnImpl: typeof spawn,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => (stdout += d.toString()))
    child.stderr?.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => reject(err))
    child.on("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else
        reject(
          new HostProviderError(
            `synapse-device pair exited ${code}: ${stderr.slice(0, 300)}`
          )
        )
    })
  })
}

function parsePairOutput(stdout: string): PairResult | null {
  // The CLI prints a JSON object; tolerate surrounding log lines by scanning
  // each line for a JSON object carrying device_id.
  const lines = stdout.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const obj = JSON.parse(trimmed)
      const deviceId = obj.device_id ?? obj.deviceId
      const serviceId = obj.service_id ?? obj.serviceId
      if (typeof deviceId === "string" && typeof serviceId === "string") {
        return {
          deviceId,
          serviceId,
          controlPlaneUrl: obj.control_plane_url ?? obj.controlPlaneUrl,
        }
      }
    } catch {
      // not this line
    }
  }
  return null
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
