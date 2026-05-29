// Terminal runtime public types. See docs/device-runtime-terminal-v2.md
// (this PR) and the plan's设计红线 for the contracts these types enforce.

export type TerminalPlatform = "win32" | "linux" | "darwin"

/**
 * Environment snapshot used by every terminal subsystem. We carry osEnv as a
 * field (instead of reading process.env on demand) so tests can inject mock
 * environments and the runtime never reads global state during execution.
 */
export interface ResolvedTerminalEnvironment {
  readonly platform: TerminalPlatform
  readonly arch: string
  readonly osEnv: Record<string, string>
  /** Absolute path to bash, or null if not on PATH. */
  readonly bash: string | null
  /** Absolute path to pwsh (preferred) or powershell.exe, or null. */
  readonly powershell: string | null
  /** Login shells reported by /etc/shells on POSIX, [] on Windows. */
  readonly loginShells: readonly string[]
  /** Probed UTF-8 status of inherited LANG/LC_CTYPE/LC_ALL. */
  readonly locale: {
    readonly lang: string | null
    readonly lcAll: string | null
    readonly lcCtype: string | null
    readonly utf8: boolean
  }
  /** Probed presence of common managed tools (absolute paths or null). */
  readonly probes: {
    readonly git: string | null
    readonly python: string | null
    readonly python3: string | null
    readonly node: string | null
  }
}

/**
 * A toolchain entry resolved by ToolchainManager. Discriminated by `source` so
 * the system-PATH branch doesn't have to pretend to know a version / rootDir
 * (it doesn't), and the bundled branches always carry the manifest-driven
 * fields. Downstream (shell/exec_file descriptor + executor) reads via
 * discriminator instead of assuming a uniform shape.
 */
export type ResolvedToolchain =
  | {
      readonly source: "system"
      readonly name: string
      readonly binPath: string
      readonly binDir: string
      readonly env: Readonly<Record<string, string>>
    }
  | {
      readonly source: "bundled-cache" | "bundled-archive"
      readonly name: string
      readonly version: string
      readonly rootDir: string
      readonly binPath: string
      readonly binDir: string
      readonly env: Readonly<Record<string, string>>
      readonly requiredFiles: readonly string[]
    }

export interface TerminalShellRequest {
  readonly kind: "shell"
  readonly executor: "bash" | "powershell"
  readonly command: string
  readonly workingDirectory?: string
  readonly timeoutMs?: number
}

export interface TerminalExecFileRequest {
  readonly kind: "exec_file"
  readonly program: string
  readonly args: readonly string[]
  readonly workingDirectory?: string
  readonly timeoutMs?: number
}

export type TerminalRequest = TerminalShellRequest | TerminalExecFileRequest

export interface TerminalExecResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly killed: boolean
  /** Set only for exec_file invocations; tracks ResolvedToolchain.source. */
  readonly toolchainSource?: "system" | "bundled-cache" | "bundled-archive"
  /** True iff stdout exceeded the per-stream cap and was truncated. */
  readonly stdoutTruncated?: boolean
  /** True iff stderr exceeded the per-stream cap and was truncated. */
  readonly stderrTruncated?: boolean
  /** Bytes dropped from stdout (≥0 even when stdoutTruncated=false, e.g.
   *  the runaway producer hit the cap mid-chunk; the result text holds
   *  everything kept and the metadata reports what was lost). */
  readonly stdoutDroppedBytes?: number
  /** Bytes dropped from stderr (same semantics). */
  readonly stderrDroppedBytes?: number
}

/**
 * Spawn descriptor produced by ShellProvider (bash/powershell) or by
 * buildExecFileDescriptor (exec_file). Carries the absolute binary path; the
 * caller of executor must NOT add shell quoting on top.
 */
export interface SpawnDescriptor {
  readonly program: string
  readonly args: readonly string[]
  readonly stdio: ["ignore", "pipe", "pipe"]
}

/**
 * Path resolver contract. POSIX/Windows behaviour differs but the entry point
 * is uniform so callers don't have to special-case platform. Caller MUST pass
 * platform explicitly (matchers and tests run on Linux CI for Windows
 * fixtures); resolver must use path.win32 / path.posix accordingly and never
 * fall back to host node's `path` default.
 */
export type PathResolver = (
  name: string,
  env: Record<string, string>,
  platform: TerminalPlatform
) => string | null

export interface ShellProvider {
  readonly executor: "bash" | "powershell"
  isAvailable(env: ResolvedTerminalEnvironment): boolean
  buildShellDescriptor(req: TerminalShellRequest): SpawnDescriptor
}

/**
 * ToolchainManager surface. resolve returns a discriminated ResolvedToolchain;
 * resolveBare returns the system-branch variant (or null) so unmanaged
 * exec_file callers get the same union and downstream stays uniform.
 */
export interface ToolchainManager {
  resolve(
    requestedName: string,
    policyAllowsBundled: boolean
  ): Promise<ResolvedToolchain>
  resolveBare(requestedName: string): Promise<ResolvedToolchain | null>
}
