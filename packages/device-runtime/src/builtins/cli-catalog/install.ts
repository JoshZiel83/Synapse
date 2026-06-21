// On-demand CLI-Anything harness install (plan §5.B / P4, LOCAL devices only).
//
// A proactive async one-shot (NOT at exec time, NOT inside describeExposures):
// for each CLI whose underlying prereq is satisfied but whose harness entry_point
// is not yet on PATH (getInstallTargets), install the lightweight pip/npm harness.
// On success it invalidates the probe memo, re-probes (flipping availableClis.
// available true), and emits a change so the runtime re-syncs the catalog → the
// server mints the program_only grant.
//
// Pins: pip harnesses install from the submodule gitlink SHA injected at build
// time (generate-cli-catalog.mjs) and run with --break-system-packages because
// the cloud base image (node:22-bookworm-slim) marks system Python externally-
// managed (PEP 668); on a local desktop --break-system-packages is harmless.
//
// Cloud/sandbox devices do NOT use this (no exec-time network; their universe is
// baked at image build, plan §5.D) — bin.ts wires the installer only on the
// local/unconfined path.

import { execFile } from "node:child_process"
import type { ResolvedTerminalEnvironment } from "../../terminal/types.js"
import type { CliCatalog, NormalizedCli } from "./index.js"

export interface CliInstaller {
  /** Probe-and-install all currently-installable CLIs once; returns installed entry_points. */
  runOnce(env: ResolvedTerminalEnvironment): Promise<string[]>
}

export interface CliInstallerOptions {
  cliCatalog: CliCatalog
  /** Override the install spawn (tests). Default spawns pip/npm via PATH. */
  runInstall?: (
    argv: string[],
    env: ResolvedTerminalEnvironment
  ) => Promise<{ ok: boolean; detail: string }>
  logger?: (msg: string) => void
}

export function createCliInstaller(opts: CliInstallerOptions): CliInstaller {
  const runInstall = opts.runInstall ?? defaultRunInstall
  const log = opts.logger ?? (() => {})
  const inFlight = new Set<string>() // per-entryPoint concurrent-install lock

  return {
    async runOnce(env) {
      const targets = await opts.cliCatalog.getInstallTargets(env)
      const installed: string[] = []
      for (const cli of targets) {
        if (inFlight.has(cli.entryPoint)) continue // already installing
        inFlight.add(cli.entryPoint)
        try {
          const argv = buildInstallArgv(cli)
          if (!argv) {
            log(
              `cli-install: no installer for ${cli.cliName} (${cli.install.manager})`
            )
            continue
          }
          log(`cli-install: installing ${cli.cliName} → ${cli.entryPoint}`)
          const res = await runInstall(argv, env)
          if (res.ok) {
            installed.push(cli.entryPoint)
            log(`cli-install: ${cli.cliName} installed`)
          } else {
            log(`cli-install: ${cli.cliName} failed: ${res.detail}`)
          }
        } catch (err) {
          log(`cli-install: ${cli.cliName} error: ${(err as Error).message}`)
        } finally {
          inFlight.delete(cli.entryPoint)
        }
      }
      if (installed.length > 0) {
        // Flip availability: re-probe (so availableClis.available becomes true)
        // then notify the runtime to re-sync → server mints the grants.
        opts.cliCatalog.invalidate()
        await opts.cliCatalog.getAvailableClis(env)
        opts.cliCatalog.emitChange()
      }
      return installed
    },
  }
}

/** Build the install argv from the catalog cmd. pip gets --break-system-packages (PEP 668). */
export function buildInstallArgv(cli: NormalizedCli): string[] | null {
  // install.cmd is a vetted, whitespace-delimited command from the build-time
  // generator (git+ URLs / pkg names contain no spaces).
  const parts = cli.install.cmd.trim().split(/\s+/)
  if (cli.install.manager === "pip") {
    const target = parts[parts.length - 1] // git+...#subdirectory or PyPI name
    if (!target) return null
    return ["pip", "install", "--break-system-packages", target]
  }
  if (cli.install.manager === "npm") {
    return parts // e.g. ["npm","install","-g","@larksuite/cli"]
  }
  return null
}

function defaultRunInstall(
  argv: string[],
  env: ResolvedTerminalEnvironment,
  timeoutMs = 180_000
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolveP) => {
    const [cmd, ...args] = argv
    if (!cmd) return resolveP({ ok: false, detail: "empty argv" })
    execFile(
      cmd,
      args,
      { env: env.osEnv, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolveP({
            ok: false,
            detail: `${err.message} ${stderr}`.slice(0, 400),
          })
        } else {
          resolveP({ ok: true, detail: String(stdout).slice(0, 200) })
        }
      }
    )
  })
}
