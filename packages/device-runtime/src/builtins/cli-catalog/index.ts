// CLI-catalog helper (plan v5 §5.B). Consulted by the commandline builtin to
// report which validated CLI-Anything CLIs are runnable on THIS device.
//
//   • loads the bundled normalized catalog + curated prereq overlay
//   • async, INVALIDATABLE memoized prereq probe (binary-on-PATH / service-
//     reachable / platform / minVersion + entry_point-on-PATH)
//   • emits an entryPoint-keyed availableClis map for the commandline exposure
//     metadata (device_exposures.metadata.availableClis)
//   • onChange/emitChange drive the post-install catalog re-sync (P4)
//
// availableClis is keyed by entryPoint (the bare program the agent runs) — NOT
// cliName — so the server-side program_only grant (program=entryPoint) and the
// matcher's program equality line up. See plan §4.2/§5.C.
//
// This builtin does NOT register a new CatalogProvider/builtin_kind: it is a
// pure helper whose output rides the existing builtin/commandline exposure.

import { createConnection } from "node:net"
import { execFile } from "node:child_process"
import type {
  ResolvedTerminalEnvironment,
  PathResolver,
} from "../../terminal/types.js"
import { defaultPathResolver } from "../../terminal/environment.js"
import catalogJson from "./cli-catalog.generated.json" with { type: "json" }
import overlayJson from "./cli-prereq-overlay.json" with { type: "json" }

export interface NormalizedCli {
  cliName: string
  entryPoint: string
  kind: "harness-cli" | "public-cli"
  install: {
    manager: "pip" | "npm"
    cmd: string
    pin?: string | null
    npxCmd?: string
    detectCmd?: string
    residual?: string
  }
  skillMd?: string | null
  displayName: string
  description: string
  category: string
  homepage?: string | null
  version?: string | null
  costTier?: string | null
  qualityTier?: string | null
  offline?: boolean | null
}

export interface CliPrereq {
  cliName: string
  entryPoint: string
  underlying: {
    binary?: string[]
    service?: { url: string | null }[]
    platform?: string[]
    minVersion?: Record<string, string>
  }
  credential: boolean
  reviewed: boolean
}

/** One entry in device_exposures.metadata.availableClis, keyed by entryPoint. */
export interface AvailableCliEntry {
  available: boolean
  source: "harness-cli" | "public-cli"
  cliName: string
  /** "ok" | "installable" | "missing:binary:<x>" | "missing:service:<url>" | "platform:<p>" | "version:<bin><got><want>" | "no-overlay" | "unverifiable:service" */
  prereq: string
  version?: string
}

export interface CliCatalog {
  /** Memoized probe → entryPoint-keyed availableClis map for exposure metadata. */
  getAvailableClis(
    env: ResolvedTerminalEnvironment
  ): Promise<Record<string, AvailableCliEntry>>
  /** Clear the memo (call after an install changes the device). */
  invalidate(): void
  /** CLIs whose underlying prereq is satisfied but whose harness is not yet on PATH (install targets, P4). */
  getInstallTargets(env: ResolvedTerminalEnvironment): Promise<NormalizedCli[]>
  /** Subscribe to change notifications (runtime subscribes → re-sync). Returns an unsubscribe fn. */
  onChange(cb: () => void): () => void
  /** Fire change notifications (install module calls this after a successful install). */
  emitChange(): void
  /** The raw catalog (install module / tests). */
  entries(): readonly NormalizedCli[]
}

export interface CliCatalogOptions {
  /** Override the bundled catalog (tests). */
  catalog?: NormalizedCli[]
  /** Override the bundled overlay (tests). */
  overlay?: CliPrereq[]
  /** PATH resolver (defaults to defaultPathResolver). */
  pathResolver?: PathResolver
  /** Service-reachability probe (default: TCP connect). Tests inject. */
  probeService?: (url: string) => Promise<boolean>
  /** Version probe (default: spawn `<bin> --version`). Tests inject. */
  probeVersion?: (
    binary: string,
    env: ResolvedTerminalEnvironment
  ) => Promise<string | null>
}

const BUNDLED_CATALOG = (catalogJson as { clis: NormalizedCli[] }).clis
const BUNDLED_OVERLAY = (overlayJson as { entries: CliPrereq[] }).entries

// Canonical binary aliases — a prereq binary is satisfied if ANY alias is on PATH.
// Modern distros + our cloud image ship `python3`/`nodejs` (not `python`/`node`),
// so probing the canonical token must accept the real executable name.
const BINARY_ALIASES: Record<string, string[]> = {
  python: ["python3", "python"],
  python3: ["python3", "python"],
  node: ["node", "nodejs"],
}

export function createCliCatalog(opts: CliCatalogOptions = {}): CliCatalog {
  const catalog = opts.catalog ?? BUNDLED_CATALOG
  const overlay = opts.overlay ?? BUNDLED_OVERLAY
  const overlayByCli = new Map(overlay.map((o) => [o.cliName, o]))
  const resolver = opts.pathResolver ?? defaultPathResolver
  const probeService = opts.probeService ?? defaultProbeService
  const probeVersion = opts.probeVersion ?? defaultProbeVersion
  const listeners = new Set<() => void>()

  let memo: Promise<Record<string, AvailableCliEntry>> | null = null

  async function probeAll(
    env: ResolvedTerminalEnvironment
  ): Promise<Record<string, AvailableCliEntry>> {
    const out: Record<string, AvailableCliEntry> = {}
    await Promise.all(
      catalog.map(async (cli) => {
        out[cli.entryPoint] = await probeOne(cli, env)
      })
    )
    return out
  }

  async function probeOne(
    cli: NormalizedCli,
    env: ResolvedTerminalEnvironment
  ): Promise<AvailableCliEntry> {
    const base: AvailableCliEntry = {
      available: false,
      source: cli.kind,
      cliName: cli.cliName,
      prereq: "ok",
    }
    try {
      const overlay = overlayByCli.get(cli.cliName)
      if (!overlay) return { ...base, prereq: "no-overlay" } // safe default: not exposed
      // Only human-reviewed entries are exposed; an unreviewed (heuristic) prereq
      // is unknown → safe-hide until a human curates a real prereq.
      if (!overlay.reviewed) return { ...base, prereq: "unreviewed" }

      const u = overlay.underlying
      const onPath = (b: string) =>
        (BINARY_ALIASES[b] ?? [b]).some(
          (c) => resolver(c, env.osEnv, env.platform) !== null
        )
      // platform
      if (
        u.platform &&
        u.platform.length > 0 &&
        !u.platform.includes(env.platform)
      ) {
        return { ...base, prereq: `platform:${env.platform}` }
      }
      // underlying binaries on PATH (alias-aware)
      for (const b of u.binary ?? []) {
        if (!onPath(b)) return { ...base, prereq: `missing:binary:${b}` }
      }
      // service reachability
      for (const s of u.service ?? []) {
        if (!s.url) return { ...base, prereq: "unverifiable:service" } // can't probe → safe-hide
        if (!(await probeService(s.url))) {
          return { ...base, prereq: `missing:service:${s.url}` }
        }
      }
      // minVersion (best-effort; binary already confirmed present above)
      let version: string | undefined
      for (const [bin, want] of Object.entries(u.minVersion ?? {})) {
        const got = await probeVersion(bin, env)
        if (got) {
          version = got
          if (compareSemver(got, want) < 0) {
            return { ...base, prereq: `version:${bin}:${got}<${want}` }
          }
        }
        // unparseable version → treat as satisfied (binary present)
      }

      // underlying satisfied → is the harness entry_point itself on PATH?
      const entryPresent =
        resolver(cli.entryPoint, env.osEnv, env.platform) !== null
      return {
        ...base,
        available: entryPresent,
        prereq: entryPresent ? "ok" : "installable",
        ...(version ? { version } : {}),
      }
    } catch {
      // A probe MUST NEVER break the whole catalog snapshot (the metadata rides
      // the commandline exposure that also carries bash/exec_file). Safe-hide on error.
      return { ...base, prereq: "probe-error" }
    }
  }

  return {
    getAvailableClis(env) {
      if (!memo) memo = probeAll(env)
      return memo
    },
    invalidate() {
      memo = null
    },
    async getInstallTargets(env) {
      const map = await (memo ?? (memo = probeAll(env)))
      return catalog.filter((c) => map[c.entryPoint]?.prereq === "installable")
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    emitChange() {
      for (const cb of listeners) {
        try {
          cb()
        } catch {
          /* a listener throwing must not break others */
        }
      }
    },
    entries() {
      return catalog
    },
  }
}

// ── default probes ────────────────────────────────────────────────────────────

function defaultProbeService(url: string, timeoutMs = 800): Promise<boolean> {
  let host: string
  let port: number
  try {
    const u = new URL(url)
    host = u.hostname
    port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolveP) => {
    const socket = createConnection({ host, port })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveP(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

function defaultProbeVersion(
  binary: string,
  env: ResolvedTerminalEnvironment,
  timeoutMs = 4000
): Promise<string | null> {
  return new Promise((resolveP) => {
    execFile(
      binary,
      ["--version"],
      { timeout: timeoutMs, env: env.osEnv, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout && !stderr) return resolveP(null)
        const m = `${stdout}${stderr}`.match(/(\d+\.\d+(?:\.\d+)?)/)
        resolveP(m ? m[1] : null)
      }
    )
  })
}

/** Returns <0 if a<b, 0 if equal, >0 if a>b. Tolerant of short versions. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
