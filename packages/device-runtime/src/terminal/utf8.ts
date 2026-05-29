// UTF-8 + env-sanitization helpers. Pure data transforms, no spawn.
// Implements the env contract in the plan: SAFE_BASE_ENV_KEYS always kept,
// DANGEROUS_ENV_KEYS stripped unless allowed, ALWAYS_INJECT_ENV always set,
// LANG/LC_CTYPE/LC_ALL normalized to a UTF-8 locale, and PATH sanitized so
// empty / relative entries never reach child processes (defense in depth on
// top of absolute-path spawn).

import { posix, win32 } from "node:path"
import { StringDecoder } from "node:string_decoder"

import type { TerminalPlatform } from "./types.js"

export const SAFE_BASE_ENV_KEYS_POSIX = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const

export const SAFE_BASE_ENV_KEYS_WINDOWS = [
  "PATH",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMFILES",
  "windir",
] as const

/**
 * Variables that can change loader/interpreter behaviour or inject helper
 * programs. Stripped by default; can be allow-listed by policy.allowedEnv.
 * `PATH/Path` are deliberately NOT here (they're in SAFE_BASE and never
 * allowed to be overridden via allowedEnv — see InvalidAllowedEnvError).
 */
export const DANGEROUS_ENV_KEYS = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "PAGER",
  "SSH_ASKPASS",
] as const

/**
 * Variables we always set on the child env (after stripping). Ordered so
 * GIT_PAGER inject (cat) wins over the dangerous-strip step.
 */
export const ALWAYS_INJECT_ENV = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
  GIT_EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
} as const

const FORBIDDEN_ALLOWED_ENV_KEY = "path"

function isForbiddenAllowedEnvKey(key: string): boolean {
  // Case-insensitive: Windows env lookup is case-insensitive (lookupEnv
  // below already proves this), so PaTh / PATH / path / Path must all be
  // rejected — otherwise a policy could whitelist `PaTh` to slip an
  // unsanitized PATH into the child env.
  return key.toLowerCase() === FORBIDDEN_ALLOWED_ENV_KEY
}

export class InvalidAllowedEnvError extends Error {
  constructor(key: string) {
    super(
      `policy.allowedEnv may not include ${JSON.stringify(
        key
      )}; PATH/Path is reserved (case-insensitive)`
    )
    this.name = "InvalidAllowedEnvError"
  }
}

export interface BuildUtf8EnvOptions {
  /** Variables (beyond SAFE_BASE) that policy explicitly allows inheriting. */
  readonly allowedEnv: readonly string[]
  /** Target platform — used for SAFE_BASE selection + locale defaults. */
  readonly platform: TerminalPlatform
}

/**
 * Returns a fresh env map suitable for child processes. Does NOT mutate
 * `osEnv` or `process.env`. Throws InvalidAllowedEnvError if PATH/Path appears
 * in `allowedEnv` (caller must surface this as `invalid_request`).
 */
export function buildUtf8Env(
  osEnv: Record<string, string | undefined>,
  options: BuildUtf8EnvOptions
): Record<string, string> {
  for (const key of options.allowedEnv) {
    if (isForbiddenAllowedEnvKey(key)) {
      throw new InvalidAllowedEnvError(key)
    }
  }

  const safeKeys =
    options.platform === "win32"
      ? SAFE_BASE_ENV_KEYS_WINDOWS
      : SAFE_BASE_ENV_KEYS_POSIX
  const out: Record<string, string> = {}

  // 1) SAFE_BASE.
  for (const key of safeKeys) {
    const value = lookupEnv(osEnv, key, options.platform)
    if (value !== undefined) {
      out[key] = value
    }
  }

  // 2) policy.allowedEnv extras.
  for (const key of options.allowedEnv) {
    const value = lookupEnv(osEnv, key, options.platform)
    if (value !== undefined) {
      out[key] = value
    }
  }

  // 3) Strip dangerous unless allow-listed.
  const allowSet = new Set(options.allowedEnv)
  for (const key of DANGEROUS_ENV_KEYS) {
    if (!allowSet.has(key)) {
      delete out[key]
    }
  }

  // 4) Always-inject.
  for (const [key, value] of Object.entries(ALWAYS_INJECT_ENV)) {
    out[key] = value
  }

  // 5) UTF-8 locale normalization.
  if (options.platform !== "win32") {
    const lcAll = out["LC_ALL"]
    if (lcAll && !isUtf8Locale(lcAll)) {
      delete out["LC_ALL"]
    }
    const fallback = options.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"
    if (!isUtf8Locale(out["LANG"])) out["LANG"] = fallback
    if (!isUtf8Locale(out["LC_CTYPE"])) out["LC_CTYPE"] = fallback
  }

  // 6) Final PATH sanitization — even if PATH untouched in steps 1-2,
  //    osEnv.PATH itself may contain empty/relative entries.
  if (out["PATH"] !== undefined) {
    out["PATH"] = sanitizePathEnv(out["PATH"], options.platform)
  }

  return out
}

/**
 * Case-insensitive env lookup on Windows; case-sensitive elsewhere. Used so
 * Windows `Path` shows up under canonical SAFE_BASE_ENV_KEYS_WINDOWS key
 * `PATH` even if the source env happened to spell it `Path`.
 */
export function lookupEnv(
  env: Record<string, string | undefined>,
  key: string,
  platform: TerminalPlatform
): string | undefined {
  if (platform !== "win32") {
    return env[key]
  }
  if (env[key] !== undefined) return env[key]
  const lowerKey = key.toLowerCase()
  for (const candidate of Object.keys(env)) {
    if (candidate.toLowerCase() === lowerKey) {
      return env[candidate]
    }
  }
  return undefined
}

function isUtf8Locale(value: string | undefined): boolean {
  if (!value) return false
  const upper = value.toUpperCase()
  return upper.includes(".UTF-8") || upper.includes(".UTF8")
}

/**
 * Removes empty and relative entries from a delimited PATH string. Uses
 * `path.win32`/`path.posix` explicitly so Linux test runners can validate
 * Windows PATH semantics (e.g. `C:\\bin` is absolute).
 */
export function sanitizePathEnv(
  rawPath: string,
  platform: TerminalPlatform
): string {
  if (!rawPath) return ""
  const delimiter = platform === "win32" ? ";" : ":"
  const isAbsolute = platform === "win32" ? win32.isAbsolute : posix.isAbsolute
  const segments = rawPath.split(delimiter)
  const kept: string[] = []
  for (const seg of segments) {
    if (!seg) continue
    if (!isAbsolute(seg)) continue
    kept.push(seg)
  }
  return kept.join(delimiter)
}

/**
 * Stream collector that buffers bytes and decodes them as UTF-8 across chunk
 * boundaries. Use feed() per chunk and finish() to flush remaining bytes.
 *
 * Bounded: once `maxBytes` of stdin bytes have been accumulated, further
 * input chunks are dropped (but `feed` still tracks how many were
 * dropped so the caller can report `truncated_bytes`). The
 * `bytesIngested()` getter lets the executor kill the spawned process
 * when EITHER stream blows past its cap — prevents a runaway `yes` or
 * recursive ls from OOM-ing the runtime / MCP response. UTF-8 safety:
 * truncation happens BEFORE the StringDecoder sees the dropped bytes,
 * so the boundary always lands on a codepoint boundary (no replacement
 * char from a half-decoded surrogate).
 */
export interface Utf8StreamCollector {
  feed(chunk: Buffer): void
  finish(): string
  /** Bytes the underlying stream sent us (including dropped overflow). */
  bytesIngested(): number
  /** Bytes we dropped because the cap was already hit. */
  bytesDropped(): number
  /** True iff at least one byte was dropped. */
  truncated(): boolean
}

export interface CreateUtf8StreamCollectorOptions {
  /** Per-stream cap in bytes. `Infinity` (or undefined) means unbounded —
   *  intended only for tests; production callers MUST pass a finite cap. */
  readonly maxBytes?: number
}

export function createUtf8StreamCollector(
  options: CreateUtf8StreamCollectorOptions = {}
): Utf8StreamCollector {
  const decoder = new StringDecoder("utf8")
  const parts: string[] = []
  const maxBytes = options.maxBytes ?? Infinity
  let kept = 0
  let dropped = 0
  return {
    feed(chunk) {
      const remaining = maxBytes - kept
      if (remaining <= 0) {
        dropped += chunk.length
        return
      }
      if (chunk.length <= remaining) {
        kept += chunk.length
        parts.push(decoder.write(chunk))
        return
      }
      // Partial chunk — keep what we can up to the cap, drop the rest.
      // StringDecoder.write buffers any trailing partial-codepoint
      // bytes internally; finish() decides whether to flush them.
      kept = maxBytes
      dropped += chunk.length - remaining
      parts.push(decoder.write(chunk.subarray(0, remaining)))
    },
    finish() {
      // CRITICAL: when truncated, do NOT call decoder.end() — flushing
      // partial-codepoint bytes turns them into U+FFFD (`�`), which
      // pollutes Chinese / other multi-byte output at the truncation
      // boundary. The partial bytes were always going to be incomplete
      // (we deliberately cut after the cap), so silently dropping the
      // dangling codepoint is the honest result.
      //
      // The non-truncated path still calls end() because a child
      // process ending mid-codepoint (rare; process killed mid-byte)
      // is genuine corruption and the replacement character is
      // appropriate signal.
      if (dropped === 0) {
        parts.push(decoder.end())
      }
      return parts.join("")
    },
    bytesIngested() {
      return kept + dropped
    },
    bytesDropped() {
      return dropped
    },
    truncated() {
      return dropped > 0
    },
  }
}
