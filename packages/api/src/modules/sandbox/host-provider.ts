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
import { z } from "zod"

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
  /** Run `synapse-device pair`; resolves with the new device/service ids. */
  pair(params: SpawnSandboxRuntimeParams): Promise<PairResult>
  /** Run `synapse-device run` as a daemon; resolves once it's spawned. */
  run(params: SpawnSandboxRuntimeParams): Promise<RunHandle>
}

const KILL_GRACE_MS = 2_000

const PairOutputSchema = z.union([
  z
    .object({
      deviceId: z.string().min(1),
      serviceId: z.string().min(1),
      controlPlaneUrl: z.string().optional(),
    })
    .passthrough()
    .transform((value): PairResult => value),
  z
    .object({
      device_id: z.string().min(1),
      service_id: z.string().min(1),
      control_plane_url: z.string().optional(),
    })
    .passthrough()
    .transform(
      (value): PairResult => ({
        deviceId: value.device_id,
        serviceId: value.service_id,
        controlPlaneUrl: value.control_plane_url,
      })
    ),
])

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
  // The CLI prints the result via JSON.stringify(result, null, 2) — pretty,
  // MULTI-LINE JSON — possibly preceded/followed by log lines. Extract the
  // first balanced {...} block (from the first '{' to its matching '}') and
  // parse that, rather than scanning line-by-line (which never sees a complete
  // object).
  const start = stdout.indexOf("{")
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        const block = stdout.slice(start, i + 1)
        try {
          const parsed = PairOutputSchema.safeParse(JSON.parse(block))
          return parsed.success ? parsed.data : null
        } catch {
          // Not valid JSON — fall through to null.
        }
        return null
      }
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

export { resolveDeviceCliPath, parsePairOutput }
