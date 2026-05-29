// Environment detection + PATH-only resolver. Replaces `which`/`where.exe`
// (which include cwd in their search order on Windows) with a manual walk of
// the PATH env using node:fs stat checks. Caller passes platform explicitly
// so Linux CI can verify Windows resolution semantics with mock env.

import { readFileSync, statSync } from "node:fs"
import { posix, win32 } from "node:path"

import type {
  PathResolver,
  ResolvedTerminalEnvironment,
  TerminalPlatform,
} from "./types.js"

/**
 * v1 PATHEXT allow-list. .BAT/.CMD/.PS1 require cmd/powershell quoting models
 * we don't implement yet, so we reject them even if PATHEXT lists them. exec_
 * file callers that need to invoke a script must use bash/powershell tools.
 */
const WINDOWS_ALLOWED_EXTENSIONS = [".EXE", ".COM"] as const

const POSIX_EXEC_BITS = 0o111

/**
 * File-existence check. Default uses `node:fs.statSync`; tests can inject a
 * mock so they can verify Windows resolver semantics on a Linux runner.
 */
export interface FileProbe {
  isExecutable(fullPath: string, platform: TerminalPlatform): boolean
}

export const defaultFileProbe: FileProbe = {
  isExecutable(fullPath, platform) {
    let stat
    try {
      stat = statSync(fullPath)
    } catch {
      return false
    }
    if (!stat.isFile()) return false
    if (platform === "win32") return true
    return (stat.mode & POSIX_EXEC_BITS) !== 0
  },
}

export function createPathResolver(
  probe: FileProbe = defaultFileProbe
): PathResolver {
  return (name, env, platform) => resolveOnPath(name, env, platform, probe)
}

/**
 * Default resolver. Pure (only depends on argv + provided env + fs stat). The
 * `pathResolver` interface allows tests to mock entirely.
 */
export const defaultPathResolver: PathResolver = createPathResolver()

function resolveOnPath(
  name: string,
  env: Record<string, string>,
  platform: TerminalPlatform,
  probe: FileProbe
): string | null {
  const pathValue = platform === "win32" ? lookupPathWindows(env) : env["PATH"]
  if (!pathValue) return null

  const pathMod = platform === "win32" ? win32 : posix
  const delimiter = platform === "win32" ? ";" : ":"
  const candidates = buildCandidateNames(name, env, platform)

  for (const rawSegment of pathValue.split(delimiter)) {
    if (!rawSegment) continue
    if (!pathMod.isAbsolute(rawSegment)) continue
    for (const candidate of candidates) {
      const full = pathMod.join(rawSegment, candidate)
      if (probe.isExecutable(full, platform)) {
        return full
      }
    }
  }
  return null
}

function lookupPathWindows(env: Record<string, string>): string | undefined {
  if (env["PATH"] !== undefined) return env["PATH"]
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") return env[key]
  }
  return undefined
}

function buildCandidateNames(
  name: string,
  env: Record<string, string>,
  platform: TerminalPlatform
): string[] {
  if (platform !== "win32") {
    return [name]
  }
  // If caller already supplied an extension, honor it but enforce allow-list.
  const lower = name.toLowerCase()
  for (const ext of WINDOWS_ALLOWED_EXTENSIONS) {
    if (lower.endsWith(ext.toLowerCase())) {
      return [name]
    }
  }
  // Any other explicit extension (.bat/.cmd/.ps1/...) → reject by returning
  // no candidates (resolver will report null rather than mis-spawn a script).
  if (lower.includes(".")) {
    const dotIdx = lower.lastIndexOf(".")
    const slashIdx = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"))
    if (dotIdx > slashIdx) {
      return []
    }
  }

  const pathext = env["PATHEXT"] ?? env["Pathext"] ?? env["pathext"]
  const fromEnv = pathext
    ? pathext
        .split(";")
        .map((ext) => ext.trim().toUpperCase())
        .filter((ext) => ext.length > 0)
    : []
  const allowed = (WINDOWS_ALLOWED_EXTENSIONS as readonly string[]).filter(
    (ext) => fromEnv.length === 0 || fromEnv.includes(ext)
  )
  return allowed.length > 0
    ? allowed.map((ext) => `${name}${ext.toLowerCase()}`)
    : (WINDOWS_ALLOWED_EXTENSIONS as readonly string[]).map(
        (ext) => `${name}${ext.toLowerCase()}`
      )
}

function isExecutable(fullPath: string, platform: TerminalPlatform): boolean {
  // Exported indirectly through defaultFileProbe; kept here so other modules
  // in this package can probe binary presence without re-importing the probe.
  return defaultFileProbe.isExecutable(fullPath, platform)
}
export { isExecutable }

export interface DetectTerminalEnvironmentOptions {
  /** Override host platform. Defaults to process.platform mapping. */
  readonly platform?: TerminalPlatform
  /** Override env snapshot. Defaults to a fresh copy of process.env. */
  readonly osEnv?: Record<string, string>
  /** Override resolver — primarily for unit tests. */
  readonly pathResolver?: PathResolver
  /** Override arch. Defaults to process.arch. */
  readonly arch?: string
}

/**
 * Probes the local environment once and returns a snapshot. Production
 * callers should reuse the result across many tool invocations.
 */
export async function detectTerminalEnvironment(
  options: DetectTerminalEnvironmentOptions = {}
): Promise<ResolvedTerminalEnvironment> {
  const platform = options.platform ?? mapHostPlatform(process.platform)
  const arch = options.arch ?? process.arch
  const osEnv = options.osEnv ?? snapshotEnv(process.env)
  const resolver = options.pathResolver ?? defaultPathResolver

  const lang = osEnv["LANG"] ?? null
  const lcAll = osEnv["LC_ALL"] ?? null
  const lcCtype = osEnv["LC_CTYPE"] ?? null
  const utf8 = [lcAll, lcCtype, lang].some(
    (value) =>
      !!value &&
      (value.toUpperCase().includes(".UTF-8") ||
        value.toUpperCase().includes(".UTF8"))
  )

  const probe = (name: string): string | null => resolver(name, osEnv, platform)

  return {
    platform,
    arch,
    osEnv,
    bash: platform === "win32" ? null : probe("bash"),
    powershell:
      platform === "win32"
        ? (probe("pwsh") ?? probe("powershell"))
        : probe("pwsh"),
    loginShells: platform === "win32" ? [] : readEtcShells(),
    locale: { lang, lcAll, lcCtype, utf8 },
    probes: {
      git: probe("git"),
      python: probe("python"),
      python3: probe("python3"),
      node: probe("node"),
    },
  }
}

function mapHostPlatform(platform: NodeJS.Platform): TerminalPlatform {
  if (platform === "win32") return "win32"
  if (platform === "darwin") return "darwin"
  // freebsd/openbsd/sunos/aix all behave like POSIX for our purposes.
  return "linux"
}

function snapshotEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

function readEtcShells(): readonly string[] {
  try {
    const contents = readFileSync("/etc/shells", "utf-8")
    return contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  } catch {
    return []
  }
}
