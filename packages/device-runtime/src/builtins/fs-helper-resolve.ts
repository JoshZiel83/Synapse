// Unified sidecar-binary resolver. Three call sites used to each roll their
// own "find the synapse-device-fs-helper binary" logic and they DISAGREED:
//   - api resolveFsHelperPath()  → release-first, throws if missing
//   - bin.ts autoDiscover*()      → release-only (no debug), returns undefined
//   - the one-shot test           → newest-wins by mtime, returns null
// That divergence is exactly how a stale build of one profile silently shadows
// a current build of the other. This module centralizes the one thing that
// legitimately differs (selection policy + missing-contract); callers still
// supply their own candidate ROOTS, because the anchor genuinely differs
// (import.meta.url-relative for installed code vs process.cwd()-relative for a
// test runner) and that difference is correct.
//
// Self-contained (only node: builtins) so the API package can import it via the
// @synapse/device-runtime barrel without dragging in the rest of the runtime.

import { existsSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Wire protocol version the TS clients expect from the fs-helper's `fs.hello`
 * handshake. MUST match `PROTO_VERSION` in sidecars/fs-helper/src/rpc.rs — bump
 * the two IN LOCKSTEP. Clients fail loud (FsHelperProtoMismatchError) when the
 * spawned binary reports a different value, which catches a stale binary whose
 * CLI args still parse but whose RPC semantics drifted.
 */
export const FS_HELPER_PROTO_VERSION = 1

/**
 * Selection policy when more than one candidate exists on disk:
 *   - "release-first": probe candidates in the given order, first hit wins.
 *     Right for PRODUCTION — a stray newer debug build must never shadow the
 *     deployed release.
 *   - "newest-wins": pick the candidate with the newest mtime across all that
 *     exist. Right for DEV/TEST — rebuilding one profile (debug) must not be
 *     shadowed by a stale build of the other (release), and vice versa.
 */
export type ResolveMode = "release-first" | "newest-wins"

export interface ResolveSidecarOptions {
  /** Candidate roots to join each suffix against (caller computes the anchor). */
  roots: string[]
  /** Path suffixes under each root, in release-first priority order. */
  suffixes: string[]
  mode: ResolveMode
  /** Env var checked first; if set and the path exists, it wins outright. */
  envVar?: string
}

/**
 * Resolve a sidecar binary path, or `undefined` if none of the candidates (and
 * no env override) exist. Never throws — use resolveSidecarPathOrThrow for the
 * fail-loud production contract.
 */
export function resolveSidecarPath(
  opts: ResolveSidecarOptions
): string | undefined {
  if (opts.envVar) {
    const fromEnv = process.env[opts.envVar]?.trim()
    if (fromEnv && existsSync(fromEnv)) return fromEnv
  }

  const candidates: string[] = []
  for (const root of opts.roots) {
    for (const suffix of opts.suffixes) {
      candidates.push(join(root, suffix))
    }
  }

  if (opts.mode === "release-first") {
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }

  // newest-wins
  let best: { path: string; mtimeMs: number } | undefined
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const mtimeMs = statSync(candidate).mtimeMs
    if (!best || mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs }
  }
  return best?.path
}

/**
 * Throwing variant for the production path: resolves the binary or throws an
 * error built by `makeError` (so callers keep their own error type without this
 * module depending on it).
 */
export function resolveSidecarPathOrThrow(
  opts: ResolveSidecarOptions,
  makeError: (message: string) => Error
): string {
  const found = resolveSidecarPath(opts)
  if (found) return found
  throw makeError(
    `${opts.suffixes[opts.suffixes.length - 1] ?? "sidecar binary"} not found ` +
      `(build it or set ${opts.envVar ?? "the override env var"})`
  )
}
