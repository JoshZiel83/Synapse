// ToolchainManager: locates `git/python/node`-class programs for
// device-runtime. Two surfaces:
//
//   resolve(requestedName, policyAllowsBundled): managed programs from the
//     bundles manifest; tries system PATH → cache → archive → auto-download
//     in that order; skips bundled path entirely unless the signed policy
//     allows it.
//
//   resolveBare(requestedName): unmanaged programs; system PATH only.
//
// Both return a ResolvedToolchain (discriminated by `source`) so downstream
// callers don't have to special-case the system branch shape.
//
// Cache root layout (must match install-bundles):
//   <toolchainDir>/<name>-<version>-<platformKey>/
// — platformKey suffix means a cross-arch install on the same machine
// can't pollute the wrong arch's cache, and the marker contains the
// extracted bytes' sha256 so a manifest entry version/sha bump
// invalidates stale cache automatically.

import { createReadStream, readFileSync } from "node:fs"
import { dirname, posix, win32 } from "node:path"

import { normalizeProgramName, programNameAliases } from "./normalize.js"
import {
  isPathInside,
  joinUnderRoot,
  ManifestPathEscapeError,
} from "./path-utils.js"
import { parseToolchainManifest } from "./manifest.js"
import type { ManifestPlatformEntry, ToolchainManifest } from "./manifest.js"
import type {
  PathResolver,
  ResolvedTerminalEnvironment,
  ResolvedToolchain,
  TerminalPlatform,
  ToolchainManager,
} from "./types.js"
import {
  bundleRootDir,
  downloadAndExtractEntry,
  isHealthyCache,
  isUsableDownloadUrl,
  PLATFORM_KEYS,
} from "../bundles/install.js"

export class ToolchainUnavailableError extends Error {
  readonly name = "ToolchainUnavailableError"
  constructor(
    public readonly programName: string,
    public readonly reason: string
  ) {
    super(`toolchain ${JSON.stringify(programName)} unavailable: ${reason}`)
  }
}

export class ToolchainSha256MismatchError extends Error {
  readonly name = "ToolchainSha256MismatchError"
  constructor(
    public readonly programName: string,
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(
      `sha256 mismatch for ${JSON.stringify(programName)}: expected ${expected} got ${actual}`
    )
  }
}

export interface CreateToolchainManagerOptions {
  /** Full path to the bundles manifest JSON (production or fixture). */
  readonly manifestPath: string
  /**
   * Parent directory of per-entry roots, e.g. `<brokerDir>/toolchains/`.
   * Each program lives at `<toolchainDir>/<name>-<version>-<platformKey>/`.
   */
  readonly toolchainDir: string
  /** Environment snapshot — supplies platform, osEnv, probe inputs. */
  readonly environment: ResolvedTerminalEnvironment
  /** Path resolver — same one used everywhere else. */
  readonly pathResolver: PathResolver
  /**
   * Override the archive-fetch path. Defaults to reading a sibling
   * `<manifest dir>/<platformKey>/<name>-<version>.tar.gz` alongside the
   * manifest (so `install-bundles` and runtime stay symmetric). Tests can
   * inject a custom locator to point at fixtures.
   */
  readonly archiveLocator?: ArchiveLocator
  /**
   * When resolve() can't find a local archive, fall back to fetching the
   * manifest entry's `download.url` directly. Defaults true — bundled
   * fallback should "just work" without forcing the operator to pre-run
   * install-bundles. Set false in tests / offline contexts. The fetch
   * still goes through sha256 verification before extraction.
   */
  readonly allowAutoDownload?: boolean
  /** Override fetch (tests). */
  readonly fetchImpl?: typeof fetch
  /**
   * Directories to check for a sha256-named pre-staged archive before
   * doing an HTTPS fetch. Operators populate these during image build
   * (or via SYNAPSE_DEVICE_PRESTAGED_DIR) so the first-run path doesn't
   * depend on outbound network access. The same sha256 check applies
   * regardless of source — a tampered or stale pre-staged file silently
   * falls back to HTTPS.
   */
  readonly prestageDirs?: readonly string[]
  /** Logger called on download / extract events. */
  readonly logger?: (message: string) => void
}

export type ArchiveLocator = (params: {
  manifestPath: string
  name: string
  version: string
  platformKey: string
  entry: ManifestPlatformEntry
}) => Promise<NodeJS.ReadableStream | null>

export function createToolchainManager(
  options: CreateToolchainManagerOptions
): ToolchainManager {
  const manifest = loadManifest(options.manifestPath)
  const platform = options.environment.platform
  const archiveLocator =
    options.archiveLocator ?? defaultArchiveLocator(options.manifestPath)
  const allowAutoDownload = options.allowAutoDownload ?? true
  const log = options.logger ?? (() => undefined)

  return {
    async resolve(requestedName, policyAllowsBundled) {
      const normName = normalizeProgramName(requestedName)
      // 1. System PATH — try requested literal first, then aliases.
      const systemHit = await tryResolveSystem(requestedName, normName, options)
      if (systemHit) return systemHit

      if (!policyAllowsBundled) {
        throw new ToolchainUnavailableError(
          normName,
          "system PATH miss and policy denies bundled fallback"
        )
      }

      const program = manifest.programs[normName]
      if (!program) {
        throw new ToolchainUnavailableError(
          normName,
          `no manifest entry for program ${JSON.stringify(normName)}`
        )
      }
      const platformKey = pickPlatformKey(
        platform,
        options.environment.arch,
        program.platforms
      )
      if (!platformKey) {
        throw new ToolchainUnavailableError(
          normName,
          `no manifest entry for platform ${platform}/${options.environment.arch}`
        )
      }
      const entry = program.platforms[platformKey]
      const rootDir = bundleRootDir(
        options.toolchainDir,
        normName,
        program.version,
        platformKey,
        platform
      )

      // 2. bundled-cache: rootDir exists with marker matching expected sha + requiredFiles present.
      if (isHealthyCache(rootDir, entry, platform)) {
        return materializeResolved({
          source: "bundled-cache",
          name: normName,
          version: program.version,
          rootDir,
          entry,
          platform,
        })
      }

      // 3. bundled-archive: locate archive bytes on disk (sibling next to manifest).
      const stream = await archiveLocator({
        manifestPath: options.manifestPath,
        name: normName,
        version: program.version,
        platformKey,
        entry,
      })
      if (stream) {
        await extractAndVerifyStream({
          stream,
          rootDir,
          entry,
          normName,
          platform,
        })
        if (!isHealthyCache(rootDir, entry, platform)) {
          throw new ToolchainUnavailableError(
            normName,
            `extracted archive does not satisfy requiredFiles for ${normName}@${program.version}`
          )
        }
        return materializeResolved({
          source: "bundled-archive",
          name: normName,
          version: program.version,
          rootDir,
          entry,
          platform,
        })
      }

      // 4. auto-download: fall back to the manifest entry's download.url.
      // Same sha256 + extract + healthCheck contract as install-bundles.
      if (!allowAutoDownload) {
        throw new ToolchainUnavailableError(
          normName,
          `no local archive for ${normName}@${program.version} on ${platformKey} and auto-download disabled — run synapse-device install-bundles`
        )
      }
      if (!isUsableDownloadUrl(entry.download.url)) {
        throw new ToolchainUnavailableError(
          normName,
          `manifest entry for ${normName}@${program.version} (${platformKey}) has no usable download.url — operator must publish the asset and update bundles/manifest.json`
        )
      }
      log(`[${normName}] auto-downloading ${entry.download.url}`)
      try {
        await downloadAndExtractEntry({
          entry,
          rootDir,
          platform,
          fetchImpl: options.fetchImpl,
          log: (m) => log(`[${normName}] ${m}`),
          prestageDirs: options.prestageDirs,
        })
      } catch (err) {
        if (err instanceof Error && /sha256 mismatch/.test(err.message)) {
          // Re-throw as the typed error so callers can distinguish.
          const m = /expected (\S+) got (\S+)/.exec(err.message)
          throw new ToolchainSha256MismatchError(
            normName,
            m?.[1] ?? entry.sha256,
            m?.[2] ?? "unknown"
          )
        }
        throw new ToolchainUnavailableError(
          normName,
          `auto-download failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (!isHealthyCache(rootDir, entry, platform)) {
        throw new ToolchainUnavailableError(
          normName,
          `auto-downloaded archive does not satisfy requiredFiles for ${normName}@${program.version}`
        )
      }
      return materializeResolved({
        source: "bundled-archive",
        name: normName,
        version: program.version,
        rootDir,
        entry,
        platform,
      })
    },
    async resolveBare(requestedName) {
      const normName = normalizeProgramName(requestedName)
      return tryResolveSystem(requestedName, normName, options)
    },
  }
}

async function tryResolveSystem(
  requestedName: string,
  normName: string,
  options: CreateToolchainManagerOptions
): Promise<ResolvedToolchain | null> {
  const platform = options.environment.platform
  const tried = new Set<string>()
  const order = [requestedName, ...programNameAliases(normName)]
  for (const candidate of order) {
    if (tried.has(candidate)) continue
    tried.add(candidate)
    const hit = options.pathResolver(
      candidate,
      options.environment.osEnv,
      platform
    )
    if (hit) {
      const pathMod = platform === "win32" ? win32 : posix
      return {
        source: "system",
        name: normName,
        binPath: hit,
        binDir: pathMod.dirname(hit),
        env: {},
      }
    }
  }
  return null
}

function loadManifest(manifestPath: string): ToolchainManifest {
  const raw = readFileSync(manifestPath, "utf-8")
  return parseToolchainManifest(JSON.parse(raw))
}

function defaultArchiveLocator(manifestPath: string): ArchiveLocator {
  return async ({ platformKey, name, version }) => {
    const archivePath = `${dirname(manifestPath)}/${platformKey}/${name}-${version}.tar.gz`
    const fs = await import("node:fs")
    if (!fs.existsSync(archivePath)) return null
    return createReadStream(archivePath)
  }
}

function pickPlatformKey(
  platform: TerminalPlatform,
  arch: string,
  available: Record<string, ManifestPlatformEntry>
): string | null {
  // Strict match only — cross-arch silent fallback was a bug (running an
  // x64 binary on arm64 by accident). Operator must populate the explicit
  // arch entry or get a clear "no manifest entry" error.
  const candidates = PLATFORM_KEYS[platform] ?? []
  for (const key of candidates) {
    if (key === `${platform}-${arch}` && available[key]) {
      return key
    }
  }
  return null
}

interface ExtractParams {
  stream: NodeJS.ReadableStream
  rootDir: string
  entry: ManifestPlatformEntry
  normName: string
  platform: TerminalPlatform
}

async function extractAndVerifyStream({
  stream,
  rootDir,
  entry,
  normName,
  platform,
}: ExtractParams) {
  // Tee buffer into memory; archives we ship are 30-80MB so this is fine.
  // The shared install.ts already does the same thing for the auto-download
  // path; here we accept a stream rather than a URL so the existing local
  // archive locator (used by tests) still works.
  const { createHash } = await import("node:crypto")
  const { mkdirSync, rmSync, writeFileSync } = await import("node:fs")
  const { Readable, pipeline } = await import("node:stream")
  const { promisify } = await import("node:util")
  const pipelineP = promisify(pipeline)
  const { x: tarExtract } = await import("tar")
  const pathMod = platform === "win32" ? win32 : posix

  rmSync(rootDir, { recursive: true, force: true })
  mkdirSync(rootDir, { recursive: true })

  const chunks: Buffer[] = []
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => {
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk, "binary") : chunk
      hash.update(buf)
      chunks.push(buf)
    })
    stream.on("error", reject)
    stream.on("end", resolve)
  })

  const actualSha = hash.digest("hex")
  if (actualSha.toLowerCase() !== entry.sha256.toLowerCase()) {
    rmSync(rootDir, { recursive: true, force: true })
    throw new ToolchainSha256MismatchError(normName, entry.sha256, actualSha)
  }

  const archiveBuf = Buffer.concat(chunks)
  await pipelineP(
    Readable.from(archiveBuf),
    tarExtract({ cwd: rootDir, strip: entry.stripComponents })
  )
  writeFileSync(pathMod.join(rootDir, ".synapse-toolchain-ok"), actualSha)
}

interface MaterializeParams {
  source: "bundled-cache" | "bundled-archive"
  name: string
  version: string
  rootDir: string
  entry: ManifestPlatformEntry
  platform: TerminalPlatform
}

function materializeResolved({
  source,
  name,
  version,
  rootDir,
  entry,
  platform,
}: MaterializeParams): ResolvedToolchain {
  const binPath = joinUnderRoot(rootDir, entry.executable, platform)
  const binDir = joinUnderRoot(rootDir, entry.binDir, platform)
  const env: Record<string, string> = {}
  for (const [key, raw] of Object.entries(entry.env)) {
    const expanded = raw.replace(/\{rootDir\}/g, rootDir)
    if (looksLikePath(expanded)) {
      if (!isPathInside(rootDir, expanded, platform)) {
        throw new ManifestPathEscapeError(rootDir, raw)
      }
    }
    env[key] = expanded
  }
  return {
    source,
    name,
    version,
    rootDir,
    binPath,
    binDir,
    env,
    requiredFiles: entry.requiredFiles,
  }
}

function looksLikePath(value: string): boolean {
  if (!value) return false
  return (
    value.startsWith("/") ||
    value.startsWith(".") ||
    /^[A-Za-z]:[\\/]/.test(value)
  )
}

/** Surface so install-bundles can re-use the marker name and platform map. */
export const TOOLCHAIN_COMPLETION_MARKER = ".synapse-toolchain-ok"
export { PLATFORM_KEYS as TOOLCHAIN_PLATFORM_KEYS }

/**
 * Returns absolute path that an archive for `(name, version, platformKey)`
 * should occupy on disk inside the manifest's `bundles/<platformKey>/` layout.
 * Shared between runtime archiveLocator and install-bundles so a cache
 * miss + install happens at the same path the resolver would later read.
 */
export function archivePathFor(
  manifestPath: string,
  platformKey: string,
  name: string,
  version: string
): string {
  return `${dirname(manifestPath)}/${platformKey}/${name}-${version}.tar.gz`
}

/** Sha256 of the absolute file path, used by install-bundles preflight. */
export async function sha256OfFile(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto")
  const { readFileSync, statSync } = await import("node:fs")
  const hash = createHash("sha256")
  const stat = statSync(filePath)
  if (!stat.isFile()) {
    throw new Error(`sha256OfFile: not a file: ${filePath}`)
  }
  const buf = readFileSync(filePath)
  hash.update(buf)
  return hash.digest("hex")
}
