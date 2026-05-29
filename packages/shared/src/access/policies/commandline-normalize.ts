// Zod-free helpers shared between API, device-runtime, and the web/mobile
// front ends. Lives in @synapse/shared/access/policies so it can be picked
// up by the root barrel (which excludes zod-bearing schema modules — see
// shared/src/index.ts comment).
//
// Three concerns:
//   - normalizeProgramName / programNameAliases: canonicalize python3 ↔ python
//     and node ↔ nodejs so manifests can use a single key while resolvers
//     accept user-facing literal names.
//   - isBareCommandName: defense against tool args trying to smuggle
//     absolute / relative / home-relative paths through an exec_file call.
//     Used by both device-side builtin and server-side buildRequestedAction.
//   - normalizeDevicePlatform: convert DB / device-reported platform strings
//     to the matcher's strict `"win32"|"linux"|"darwin"|undefined` shape so
//     unknown platforms don't accidentally trip Windows-specific guards.

export type NormalizedDevicePlatform = "win32" | "linux" | "darwin"

/**
 * Programs the runtime is willing to auto-fall-back-to-bundled via the
 * device-runtime ToolchainManager. Single source of truth so the API's
 * `buildRequestedAction` (which sets `allowBundledToolchain: true` on the
 * requested grant) and the device-runtime's commandline builtin (which
 * routes to `ToolchainManager.resolve` instead of `resolveBare` for these
 * programs) can't drift.
 *
 * To add a program here:
 *   1. Publish a vetted bundled asset (sha-pinned URL in
 *      packages/device-runtime/bundles/manifest.json — see bundles/
 *      README.md for the supply-chain rules) for at least one platform.
 *   2. Add the program name (in its normalized form — `python` not
 *      `python3`) to this list.
 *   3. Update `BUNDLE_PROGRAM_PLATFORM_KEYS` below with the platforms the
 *      program is ACTUALLY available on. The API uses this to refuse
 *      setting `allowBundledToolchain: true` on a Windows device when
 *      we only have Linux/macOS entries, so the user doesn't get an
 *      approved-but-unrunnable grant.
 *   4. The device-side resolver fails closed if a request hits this list
 *      but the per-platform manifest entry is missing, so the user sees
 *      `toolchain_unavailable` instead of being approved-but-unrunnable.
 *
 * git is included here as of the git-for-windows MinGit integration:
 * Windows x64 + arm64 are covered by official upstream binaries (see
 * bundles/manifest.json — git entry, trustedSource "git-for-windows").
 * Linux/Darwin entries are intentionally NOT listed in PLATFORM_KEYS
 * below because there is no canonical upstream portable git for those
 * platforms — see bundles/build-scripts/git-linux-x64.sh for the
 * Synapse self-build path that will fill those slots when Synapse
 * publishes its own release asset (one atomic PR: ship asset → add
 * manifest entries → add platformKeys; the parity test in
 * src/terminal/manifest.test.ts will fire red if these drift).
 */
export const BUNDLE_ELIGIBLE_PROGRAMS: readonly string[] = [
  "python",
  "node",
  "git",
] as const

/**
 * Per-program list of platformKey entries (`<platform>-<arch>`) where the
 * bundled asset is actually available. API uses this together with
 * `BUNDLE_ELIGIBLE_PROGRAMS` to gate `allowBundledToolchain: true` per
 * device, so a Windows device or arm-only device never gets approved-
 * but-unrunnable bundled grants.
 *
 * MUST stay in sync with the platform entries in
 * packages/device-runtime/bundles/manifest.json. The
 * `manifest.production.template.json` documents what's intentionally
 * missing (git linux/darwin entries pending a Synapse-built static
 * binary asset).
 */
export const BUNDLE_PROGRAM_PLATFORM_KEYS: Readonly<
  Record<string, readonly `${NormalizedDevicePlatform}-${string}`[]>
> = {
  python: ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"],
  node: ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"],
  // git-for-windows ships only Windows portable binaries (MinGit x64 +
  // arm64). Linux/Darwin git is intentionally absent — see the
  // BUNDLE_ELIGIBLE_PROGRAMS comment above for the follow-up plan.
  git: ["win32-x64", "win32-arm64"],
}

/**
 * Load-time invariant: every BUNDLE_ELIGIBLE_PROGRAMS entry MUST appear
 * as a non-empty key in BUNDLE_PROGRAM_PLATFORM_KEYS. If this assertion
 * trips, the API would claim a program is bundle-fallback-able while the
 * device-side resolver has zero matching manifest entries — the original
 * "approved but unrunnable" bug. Tripping at import time is loud: it
 * crashes the API process and the device-runtime CLI on startup so the
 * mistake never reaches a user-visible approval flow.
 */
for (const program of BUNDLE_ELIGIBLE_PROGRAMS) {
  const keys = BUNDLE_PROGRAM_PLATFORM_KEYS[program]
  if (!keys || keys.length === 0) {
    throw new Error(
      `BUNDLE_ELIGIBLE_PROGRAMS lists "${program}" but BUNDLE_PROGRAM_PLATFORM_KEYS has no non-empty entry. ` +
        `Add the program's platformKeys (matching packages/device-runtime/bundles/manifest.json) ` +
        `or remove it from BUNDLE_ELIGIBLE_PROGRAMS so the API stops proposing allowBundledToolchain.`
    )
  }
}

/**
 * Back-compat view: the union of platforms across all platformKeys.
 * Retained because external consumers (UIs / docs / tooling) may want a
 * platform-only list. Prefer `BUNDLE_PROGRAM_PLATFORM_KEYS` for any
 * gating decision.
 */
export const BUNDLE_PROGRAM_PLATFORMS: Readonly<
  Record<string, readonly NormalizedDevicePlatform[]>
> = (() => {
  const out: Record<string, NormalizedDevicePlatform[]> = {}
  for (const [program, keys] of Object.entries(BUNDLE_PROGRAM_PLATFORM_KEYS)) {
    const set = new Set<NormalizedDevicePlatform>()
    for (const key of keys) {
      const platform = key.split("-")[0] as NormalizedDevicePlatform
      set.add(platform)
    }
    out[program] = Array.from(set)
  }
  return out
})()

/** True iff the program (after normalization) is on the bundle-eligible list. */
export function isBundleEligibleProgram(name: string): boolean {
  const normalized = normalizeProgramName(name)
  return BUNDLE_ELIGIBLE_PROGRAMS.includes(normalized)
}

/**
 * True iff the program is bundle-eligible AND we ship a bundled archive
 * for the given (platform, arch) combination. Strict by default:
 *
 *   - Unknown platform → false. The API can't claim bundled-fallback
 *     for a device that hasn't reported its platform (the conservative-
 *     permissive previous behavior let local-pairing devices with NULL
 *     platform slip through, defeating the Windows guard).
 *   - Unknown arch → false. The runtime manifest matches on
 *     `<platform>-<arch>` exactly; promising bundled without arch
 *     would create a fresh "approved-but-unrunnable" path for arm-
 *     only devices.
 */
export function isBundleAvailableForPlatform(
  name: string,
  platform: NormalizedDevicePlatform | null | undefined,
  arch: string | null | undefined
): boolean {
  const normalized = normalizeProgramName(name)
  const keys = BUNDLE_PROGRAM_PLATFORM_KEYS[normalized]
  if (!keys || keys.length === 0) return false
  if (!platform || !arch) return false
  return keys.includes(
    `${platform}-${arch}` as `${NormalizedDevicePlatform}-${string}`
  )
}

const REVERSE_ALIASES: Record<string, string> = {
  python3: "python",
  nodejs: "node",
}

const ALIASES: Record<string, readonly string[]> = {
  python: ["python", "python3"],
  node: ["node", "nodejs"],
}

/**
 * Folds `python3 → python`, `nodejs → node`; other names pass through. Used
 * by ToolchainManager + matcher so manifest keys can stay canonical.
 */
export function normalizeProgramName(name: string): string {
  return REVERSE_ALIASES[name] ?? name
}

/**
 * Order in which the resolver tries names on PATH. Caller MUST first try
 * the literal requested name before falling through to this list (so
 * `program=python3` is honored when both `python` and `python3` exist).
 */
export function programNameAliases(normalizedName: string): readonly string[] {
  return ALIASES[normalizedName] ?? [normalizedName]
}

/**
 * Returns true iff `program` is a plain command name (no path separators,
 * no parent traversal, no home expansion, not absolute). Rejecting these
 * prevents tool input from upgrading "tool name authorization" to
 * "arbitrary binary path authorization".
 */
export function isBareCommandName(program: string): boolean {
  if (typeof program !== "string") return false
  if (program.length === 0) return false
  if (program.startsWith("~")) return false
  if (program.includes("/") || program.includes("\\")) return false
  if (program.includes("..")) return false
  // Treat any explicit colon (Windows `C:\` form was already excluded by `\`,
  // but POSIX drive-letter-style ahead of strict path check) as suspicious.
  if (program.includes(":")) return false
  return true
}

/**
 * Folds DB / device-reported platform strings into the matcher's expected
 * shape. Unknown values (freebsd / openbsd / sunos / aix / "") return
 * undefined so callers don't run Windows-specific guards by accident.
 */
export function normalizeDevicePlatform(
  raw: string | null | undefined
): NormalizedDevicePlatform | undefined {
  if (!raw) return undefined
  const lowered = raw.toLowerCase()
  if (lowered === "win32" || lowered === "windows") return "win32"
  if (
    lowered === "darwin" ||
    lowered === "mac" ||
    lowered === "macos" ||
    lowered === "osx"
  ) {
    return "darwin"
  }
  if (lowered === "linux") return "linux"
  return undefined
}
