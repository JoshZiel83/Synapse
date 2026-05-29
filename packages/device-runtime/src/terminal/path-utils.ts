// Path utilities used by ToolchainManager / bundles install to keep
// extracted archives confined to a known root. Pulled out so the same
// `isPathInside` helper drives both runtime resolve and install-time
// validation, and so tests can hit a single canonical implementation.

import { posix, win32 } from "node:path"

import type { TerminalPlatform } from "./types.js"

/**
 * Returns true iff `candidate` resolves to a path inside (or equal to) the
 * `rootDir`. Uses path.win32 / path.posix explicitly so cross-platform tests
 * stay deterministic; Windows normalization is case-insensitive.
 *
 * Treats `rootDir === candidate` as inside (so a manifest can reference its
 * own root, e.g. binDir = ".").
 */
export function isPathInside(
  rootDir: string,
  candidate: string,
  platform: TerminalPlatform
): boolean {
  const pathMod = platform === "win32" ? win32 : posix
  const normalizedRoot = pathMod.resolve(rootDir)
  const normalizedCandidate = pathMod.resolve(rootDir, candidate)
  const compareRoot =
    platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot
  const compareCandidate =
    platform === "win32"
      ? normalizedCandidate.toLowerCase()
      : normalizedCandidate
  if (compareCandidate === compareRoot) return true
  const rel = pathMod.relative(normalizedRoot, normalizedCandidate)
  if (rel.length === 0) return true
  if (rel.startsWith("..")) return false
  if (pathMod.isAbsolute(rel)) return false
  return true
}

export class ManifestPathEscapeError extends Error {
  constructor(rootDir: string, attempted: string) {
    super(
      `manifest path escapes toolchain root: rootDir=${JSON.stringify(
        rootDir
      )} attempted=${JSON.stringify(attempted)}`
    )
    this.name = "ManifestPathEscapeError"
  }
}

export function joinUnderRoot(
  rootDir: string,
  relative: string,
  platform: TerminalPlatform
): string {
  const pathMod = platform === "win32" ? win32 : posix
  const absolute = pathMod.resolve(rootDir, relative)
  if (!isPathInside(rootDir, absolute, platform)) {
    throw new ManifestPathEscapeError(rootDir, relative)
  }
  return absolute
}
