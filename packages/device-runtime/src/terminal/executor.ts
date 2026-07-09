// spawnTerminalProcess: thin layer over child_process.spawn that:
//   1. Merges baseEnv + ResolvedToolchain.env in trusted order (toolchain
//      env always wins, NEVER stripped as "dangerous" because it came from
//      the signed manifest).
//   2. Prepends toolchain binDirs onto baseEnv.PATH and re-sanitizes the
//      result so empty/relative entries can't sneak in via the toolchain
//      side.
//   3. Spawns POSIX children in their own process group so SIGTERM/SIGKILL
//      reaches every git/python/node descendant on timeout; on Windows
//      uses taskkill /T /F (resolved via SystemRoot, never $PATH).
//   4. Streams stdout/stderr through StringDecoder so multi-byte UTF-8
//      characters split across chunks still decode correctly.
//   5. NEVER mutates process.env.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { posix, win32 } from "node:path"

import { createUtf8StreamCollector, sanitizePathEnv } from "./utf8.js"
import type {
  SpawnDescriptor,
  TerminalExecResult,
  TerminalPlatform,
} from "./types.js"

const DEFAULT_TIMEOUT_MS = 60_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 300_000
const KILL_ESCALATION_DELAY_MS = 2_000

/**
 * Default per-stream output cap. Prevents `yes`, recursive directory
 * listing, or accidentally printing a binary file from OOMing the
 * runtime or producing a multi-GB MCP response. Tuned to ~comfortable
 * model-context size; raise via SpawnTerminalProcessOptions.maxOutputBytes
 * if a tool legitimately needs more (rare).
 */
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576 // 1 MiB per stream
const MIN_MAX_OUTPUT_BYTES = 4 * 1024 // 4 KiB — anything below blocks normal output
const MAX_MAX_OUTPUT_BYTES = 64 * 1_048_576 // 64 MiB hard cap so callers can't override away the guard

export interface SpawnTerminalProcessOptions {
  readonly cwd?: string
  /** Output of buildUtf8Env (already sanitized, including PATH). */
  readonly baseEnv: Record<string, string>
  /** Absolute directories to prepend to PATH. May be empty for shell-only. */
  readonly toolchainBinDirs: readonly string[]
  /** Trusted env from ResolvedToolchain.env (NOT subject to dangerous strip). */
  readonly toolchainEnv: Readonly<Record<string, string>>
  /** Target platform — drives delimiter + taskkill resolution. */
  readonly platform: TerminalPlatform
  /** OS env snapshot — used to derive Windows taskkill path. */
  readonly osEnv: Record<string, string>
  /** Per-call timeout. Default 60s, clamped to [1s, 300s]. */
  readonly timeoutMs?: number
  /**
   * Per-stream cap in bytes (stdout and stderr counted separately). When
   * EITHER stream hits the cap, the process group is killed via the
   * same SIGTERM→SIGKILL escalation as the timeout path. Default 1 MiB
   * per stream; clamped to [4 KiB, 64 MiB].
   */
  readonly maxOutputBytes?: number
  /**
   * Optional abort signal (S4). When it fires, THIS child's own process group
   * is killed via the same SIGTERM→SIGKILL escalation as the timeout path — and
   * ONLY this child's group (kill(-pid)); it never touches a sibling runtime.
   * Used by the sandbox adapter's per-SandboxHandle scoped dispose() to drain
   * exactly the children it spawned. Omitted → unchanged behavior.
   */
  readonly signal?: AbortSignal
}

/**
 * Output of the executor. `toolchainSource` is set by the builtin
 * (commandline.invokeTool) for exec_file calls so the tool-result _meta can
 * report which source served the binary.
 */
export type SpawnedTerminalResult = TerminalExecResult

export async function spawnTerminalProcess(
  descriptor: SpawnDescriptor,
  options: SpawnTerminalProcessOptions
): Promise<SpawnedTerminalResult> {
  const platform = options.platform
  const isWin = platform === "win32"
  const delim = isWin ? ";" : ":"

  const envForChild: Record<string, string> = { ...options.baseEnv }
  // Merge toolchain env (trusted) — overrides baseEnv on key conflicts.
  for (const [k, v] of Object.entries(options.toolchainEnv)) {
    envForChild[k] = v
  }
  const pathSegments = [
    ...options.toolchainBinDirs,
    envForChild["PATH"],
  ].filter((s): s is string => typeof s === "string" && s.length > 0)
  envForChild["PATH"] = sanitizePathEnv(pathSegments.join(delim), platform)

  const timeoutMs = clampTimeout(options.timeoutMs)
  const maxOutputBytes = clampMaxOutputBytes(options.maxOutputBytes)
  const start = Date.now()

  return new Promise<SpawnedTerminalResult>((resolve, reject) => {
    let timedOut = false
    let killed = false
    let outputOverflowKilled = false
    // Hoisted up here so both the per-stream overflow handler AND the
    // timeout handler can schedule the SIGKILL escalation without
    // duplicating it.
    let escalationTimer: NodeJS.Timeout | null = null

    const child = spawn(descriptor.program, descriptor.args.slice(), {
      cwd: options.cwd,
      env: envForChild,
      stdio: descriptor.stdio.slice() as ["ignore", "pipe", "pipe"],
      detached: !isWin, // POSIX: own process group so kill(-pid) reaches descendants
      windowsHide: true,
    })

    const stdoutCollector = createUtf8StreamCollector({
      maxBytes: maxOutputBytes,
    })
    const stderrCollector = createUtf8StreamCollector({
      maxBytes: maxOutputBytes,
    })

    // Kill the process group when EITHER stream hits the cap. Same kill
    // path as timeout, so descendants (sleep, git, python, ...) die
    // along with the shell. We track the trigger separately so the
    // result.killed flag reflects either timeout OR output-overflow.
    const checkOverflowAndMaybeKill = () => {
      if (outputOverflowKilled || timedOut) return
      if (stdoutCollector.truncated() || stderrCollector.truncated()) {
        outputOverflowKilled = true
        killed = true
        killProcessTree(child.pid, platform, options.osEnv, "SIGTERM")
        if (escalationTimer === null) {
          escalationTimer = setTimeout(() => {
            killProcessTree(child.pid, platform, options.osEnv, "SIGKILL")
          }, KILL_ESCALATION_DELAY_MS)
        }
      }
    }

    child.stdout?.on("data", (chunk) => {
      stdoutCollector.feed(toBuffer(chunk))
      checkOverflowAndMaybeKill()
    })
    child.stderr?.on("data", (chunk) => {
      stderrCollector.feed(toBuffer(chunk))
      checkOverflowAndMaybeKill()
    })

    const timer = setTimeout(() => {
      timedOut = true
      killed = true
      killProcessTree(child.pid, platform, options.osEnv, "SIGTERM")
      // The overflow handler might have already scheduled the SIGKILL
      // escalation; don't double-schedule it.
      if (escalationTimer === null) {
        escalationTimer = setTimeout(() => {
          killProcessTree(child.pid, platform, options.osEnv, "SIGKILL")
        }, KILL_ESCALATION_DELAY_MS)
      }
    }, timeoutMs)

    // Scoped dispose (S4): abort → kill THIS child's own group only. Same
    // escalation as timeout/overflow; never signals any other pid.
    const onAbort = (): void => {
      if (killed || timedOut) return
      killed = true
      killProcessTree(child.pid, platform, options.osEnv, "SIGTERM")
      if (escalationTimer === null) {
        escalationTimer = setTimeout(() => {
          killProcessTree(child.pid, platform, options.osEnv, "SIGKILL")
        }, KILL_ESCALATION_DELAY_MS)
      }
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }

    child.on("error", (err) => {
      clearTimeout(timer)
      if (escalationTimer) clearTimeout(escalationTimer)
      options.signal?.removeEventListener("abort", onAbort)
      reject(err)
    })

    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (escalationTimer) clearTimeout(escalationTimer)
      options.signal?.removeEventListener("abort", onAbort)
      const stdout = stdoutCollector.finish()
      const stderr = stderrCollector.finish()
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        killed: timedOut || signal !== null || killed,
        stdoutTruncated: stdoutCollector.truncated(),
        stderrTruncated: stderrCollector.truncated(),
        stdoutDroppedBytes: stdoutCollector.bytesDropped(),
        stderrDroppedBytes: stderrCollector.bytesDropped(),
      })
    })
  })
}

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "binary") : chunk
}

function clampTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)))
}

function clampMaxOutputBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_OUTPUT_BYTES
  }
  return Math.max(
    MIN_MAX_OUTPUT_BYTES,
    Math.min(MAX_MAX_OUTPUT_BYTES, Math.trunc(value))
  )
}

function killProcessTree(
  pid: number | undefined,
  platform: TerminalPlatform,
  osEnv: Record<string, string>,
  signal: NodeJS.Signals
) {
  if (typeof pid !== "number") return
  if (platform === "win32") {
    const taskkill = resolveTaskkillPath(osEnv)
    if (!taskkill) {
      // Fallback: single-process kill — the warning bubbles up via the
      // caller logger when applicable; we keep executor pure here.
      try {
        process.kill(pid, signal)
      } catch {
        /* best-effort */
      }
      return
    }
    try {
      spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        detached: false,
        stdio: "ignore",
      }).unref()
    } catch {
      /* best-effort */
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* best-effort */
    }
  }
}

export function resolveTaskkillPath(
  osEnv: Record<string, string>
): string | null {
  const root = osEnv["SystemRoot"] ?? osEnv["windir"] ?? "C:\\Windows"
  const candidate = win32.join(root, "System32", "taskkill.exe")
  return existsSync(candidate) ? candidate : null
}

/** Helper exposed for tests that need to assert the assembled env without
 *  actually spawning a child. */
export function previewSpawnEnv(
  options: SpawnTerminalProcessOptions
): Record<string, string> {
  const isWin = options.platform === "win32"
  const delim = isWin ? ";" : ":"
  const env: Record<string, string> = { ...options.baseEnv }
  for (const [k, v] of Object.entries(options.toolchainEnv)) env[k] = v
  const pathSegments = [...options.toolchainBinDirs, env["PATH"]].filter(
    (s): s is string => typeof s === "string" && s.length > 0
  )
  env["PATH"] = sanitizePathEnv(pathSegments.join(delim), options.platform)
  return env
}

// Re-exported for consumer convenience.
export { posix as posixPath, win32 as win32Path }
