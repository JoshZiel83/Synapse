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

/** The sidecar binary's basename — the single spelling every consumer uses. */
export const FS_HELPER_BIN_NAME = "synapse-device-fs-helper"

/** Env override checked first by every resolver. */
export const FS_HELPER_ENV_VAR = "SYNAPSE_DEVICE_FS_HELPER_PATH"

/**
 * Wire protocol version the TS clients expect from the fs-helper's `fs.hello`
 * handshake. MUST match `PROTO_VERSION` in sidecars/fs-helper/src/rpc.rs — bump
 * the two IN LOCKSTEP. Clients fail loud (FsHelperProtoMismatchError) when the
 * spawned binary reports a different value, which catches a stale binary whose
 * CLI args still parse but whose RPC semantics drifted.
 */
export const FS_HELPER_PROTO_VERSION = 2

/**
 * Thrown when the spawned fs-helper reports a proto_version that doesn't match
 * FS_HELPER_PROTO_VERSION (or predates the `fs.hello` handshake entirely). Both
 * the one-shot driver and the long-lived client throw this on (re)spawn, so a
 * stale binary fails loud instead of silently mis-serving RPCs.
 */
export class FsHelperProtoMismatchError extends Error {
  constructor(
    public readonly expected: number,
    public readonly got: number | undefined,
    public readonly crateVersion: string | undefined
  ) {
    super(
      `fs-helper protocol mismatch: client expects proto_version=${expected}, ` +
        `helper reports ${got ?? "none (pre-handshake binary)"}${
          crateVersion ? ` (crate ${crateVersion})` : ""
        }. Rebuild the sidecar (build:fs-helper).`
    )
    this.name = "FsHelperProtoMismatchError"
  }
}

/**
 * Validate an `fs.hello` result against the pinned proto version. Throws
 * FsHelperProtoMismatchError on mismatch or a malformed/absent result.
 */
export function assertFsHelperProto(hello: unknown): void {
  const obj =
    typeof hello === "object" && hello !== null
      ? (hello as { proto_version?: unknown; crate_version?: unknown })
      : {}
  const got =
    typeof obj.proto_version === "number" ? obj.proto_version : undefined
  const crate =
    typeof obj.crate_version === "string" ? obj.crate_version : undefined
  if (got !== FS_HELPER_PROTO_VERSION) {
    throw new FsHelperProtoMismatchError(FS_HELPER_PROTO_VERSION, got, crate)
  }
}

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

// ─────────────────────────── profile single-source-of-truth ────────────────
//
// The fs-helper has two consumption profiles that differ ONLY in suffix order +
// selection mode. Express that ONCE here so every consumer — the api resolver,
// the device-runtime one-shot test, AND the pretest freshness guard — derives
// its candidates from the same table instead of re-spelling them. (The pretest
// guard used to re-enumerate candidates in bash and drifted out of sync with
// this module four times; it now calls fsHelperCandidatePaths via tsx instead.)

export type FsHelperProfile = "release" | "debug"

interface FsHelperProfileSpec {
  mode: ResolveMode
  /** Suffixes under <sidecarDir>, in priority order. */
  suffixes: string[]
  /** The path a `cargo build [--release]` of this profile writes. */
  buildOutput: string
}

const REL = join("target", "release", FS_HELPER_BIN_NAME)
const DBG = join("target", "debug", FS_HELPER_BIN_NAME)

/**
 * Per-profile selection rules. The ONLY place suffix order / mode / build output
 * are defined:
 *   - release: api's production path. release-first (a stray newer debug must
 *     not shadow the deployed release); also accepts a bare binary next to the
 *     sidecar dir. `cargo build --release` writes target/release.
 *   - debug: device-runtime's dev/test path. newest-wins (rebuilding one profile
 *     must not be shadowed by a stale build of the other). `cargo build` writes
 *     target/debug.
 */
export const FS_HELPER_PROFILES: Record<FsHelperProfile, FsHelperProfileSpec> =
  {
    release: {
      mode: "release-first",
      suffixes: [REL, DBG, FS_HELPER_BIN_NAME],
      buildOutput: REL,
    },
    debug: { mode: "newest-wins", suffixes: [DBG, REL], buildOutput: DBG },
  }

/**
 * Absolute on-disk candidates (env override excluded) a profile would probe,
 * anchored at `sidecarDir`. Order matches the profile's suffix priority.
 */
export function fsHelperCandidatePaths(
  profile: FsHelperProfile,
  sidecarDir: string
): string[] {
  return FS_HELPER_PROFILES[profile].suffixes.map((s) => join(sidecarDir, s))
}

/** The path `cargo build`/`cargo build --release` of this profile produces. */
export function fsHelperBuildOutput(
  profile: FsHelperProfile,
  sidecarDir: string
): string {
  return join(sidecarDir, FS_HELPER_PROFILES[profile].buildOutput)
}

/**
 * Resolve the binary a profile would actually pick, anchored at `sidecarDir`,
 * honoring the env override exactly like every other consumer. Returns undefined
 * if nothing resolves. This is what the pretest guard calls (via tsx) so it
 * never re-implements resolution logic in bash.
 */
export function resolveFsHelperForProfile(
  profile: FsHelperProfile,
  sidecarDir: string
): string | undefined {
  const spec = FS_HELPER_PROFILES[profile]
  return resolveSidecarPath({
    roots: [sidecarDir],
    suffixes: spec.suffixes,
    mode: spec.mode,
    envVar: FS_HELPER_ENV_VAR,
  })
}
