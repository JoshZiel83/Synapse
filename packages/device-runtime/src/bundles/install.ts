// install-bundles: eager downloader that materializes the toolchain
// archives a device needs before runtime resolve hits them. Reads the
// production manifest (same one runtime resolve uses), downloads each
// per-platform archive (with sha256 verification), and extracts under
// <toolchainDir>/<name>-<version>-<platformKey>/. Writes a completion
// marker containing the verified sha256 only after every requiredFile is
// present so partial state never gets re-used and stale-sha caches get
// invalidated when the manifest entry's expected sha256 changes.
//
// The single-entry `downloadAndExtractEntry` is also called by
// ToolchainManager.resolve() when a cache miss happens AND the operator
// has opted in to runtime auto-download (default behavior — the bundle
// fallback is supposed to "just work" without a separate install step).

import { createHash } from "node:crypto"
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname as dirnameOf, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"

import { x as tarExtract } from "tar"
import unzipper from "unzipper"

import { isPathInside, joinUnderRoot } from "../terminal/path-utils.js"
import {
  assertTrustedDownload,
  parseToolchainManifest,
  UntrustedDownloadSourceError,
} from "../terminal/manifest.js"
import type {
  ManifestPlatformEntry,
  ToolchainManifest,
  TrustedSourceKey,
} from "../terminal/manifest.js"

// China Node-dist mirror key -> { base, trustedSource }. The base path differs
// per host, so we replace the WHOLE https://nodejs.org/dist/ prefix (not just
// the hostname) and switch trustedSource to the matching allow-list key, both
// BEFORE assertTrustedDownload. Only these 5 keys are accepted; anything else
// (incl. "nodejs"/custom URLs/empty) leaves the entry untouched (official).
const NODE_MIRRORS: Record<
  string,
  { base: string; trustedSource: TrustedSourceKey }
> = {
  ustc: {
    base: "https://mirrors.ustc.edu.cn/node/",
    trustedSource: "nodejs.org-ustc",
  },
  huawei: {
    base: "https://mirrors.huaweicloud.com/nodejs/",
    trustedSource: "nodejs.org-huawei",
  },
  tencent: {
    base: "https://mirrors.cloud.tencent.com/nodejs-release/",
    trustedSource: "nodejs.org-tencent",
  },
  aliyun: {
    base: "https://mirrors.aliyun.com/nodejs-release/",
    trustedSource: "nodejs.org-aliyun",
  },
  npmmirror: {
    base: "https://cdn.npmmirror.com/binaries/node/",
    trustedSource: "nodejs.org-npmmirror",
  },
}

const NODE_OFFICIAL_PREFIX = "https://nodejs.org/dist/"

// Returns a copy of the entry with its download URL prefix-rewritten to the
// chosen China mirror (and trustedSource switched). No-op unless the key is a
// known mirror AND the URL is a canonical nodejs.org/dist URL. The sha256 is
// the official value and is left untouched — it still gates the bytes.
function rewriteToNodeMirror(
  entry: ManifestPlatformEntry,
  mirrorKey: string | undefined
): ManifestPlatformEntry {
  if (!mirrorKey) return entry
  const mirror = NODE_MIRRORS[mirrorKey]
  if (!mirror) return entry // unknown key / "nodejs" / custom: official source
  if (!entry.download.url.startsWith(NODE_OFFICIAL_PREFIX)) return entry
  const rewrittenUrl =
    mirror.base + entry.download.url.slice(NODE_OFFICIAL_PREFIX.length)
  return {
    ...entry,
    download: {
      ...entry.download,
      url: rewrittenUrl,
      trustedSource: mirror.trustedSource,
    },
  }
}
import type { TerminalPlatform } from "../terminal/types.js"

export const COMPLETION_MARKER = ".synapse-toolchain-ok"

export const PLATFORM_KEYS: Record<TerminalPlatform, readonly string[]> = {
  win32: ["win32-x64", "win32-arm64"],
  linux: ["linux-x64", "linux-arm64"],
  darwin: ["darwin-x64", "darwin-arm64"],
}

/**
 * Per-entry root directory layout. Pulled out so install + runtime resolve
 * agree on where bytes land. NOTE: platformKey is part of the directory so
 * cross-architecture installs on the same machine (rare but possible — think
 * cross-compilation) can't pollute each other.
 *
 * Uses the HOST node:path module (via the plain `join` import) — `toolchainDir`
 * is an actual filesystem path on the running machine, not a manifest-
 * declared path, so cross-prepping (e.g. running `install-bundles
 * --platform=win32-x64` on a Linux operator host) must still produce a
 * directory the local fs can mkdir. The `platform` parameter is kept in
 * the signature for API symmetry but is not used for the path join: the
 * suffix is a fixed-format Synapse-internal segment (no manifest input)
 * so there is no escape risk here. Platform-aware path semantics still
 * apply to manifest-declared entries (executable / requiredFiles / env
 * template values) via joinUnderRoot called separately in
 * extractAndVerifyStream / extractZip.
 */
export function bundleRootDir(
  toolchainDir: string,
  name: string,
  version: string,
  platformKey: string,
  _platform: TerminalPlatform
): string {
  return join(toolchainDir, `${name}-${version}-${platformKey}`)
}

export interface InstallBundlesOptions {
  manifest: ToolchainManifest
  toolchainDir: string
  platform: TerminalPlatform
  arch: string
  /** Optional fetch override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Whether to skip programs that already have a healthy cache. */
  skipExisting?: boolean
  logger?: (message: string) => void
  /**
   * Directories to check for a pre-staged archive (sha256-named) before
   * issuing an HTTPS GET. Operators populate these during image build so
   * deployment never reaches the network. See `defaultPrestageDirs` for
   * the standard set used by the CLI.
   */
  prestageDirs?: readonly string[]
  /**
   * When true, fail the install (rather than HTTP-fall-back) if a manifest
   * entry has no matching pre-staged archive. Used by air-gapped operators
   * who must NEVER hit the network during deployment.
   */
  requirePrestaged?: boolean
  /** China Node-dist mirror key, forwarded to downloadAndExtractEntry. */
  toolchainMirror?: string
}

export interface InstallBundlesReport {
  installed: Array<{
    name: string
    version: string
    platformKey: string
    rootDir: string
    bytes: number
  }>
  skipped: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; reason: string }>
}

export async function installBundles(
  opts: InstallBundlesOptions
): Promise<InstallBundlesReport> {
  const log = opts.logger ?? (() => undefined)
  const fetchImpl = opts.fetchImpl ?? fetch
  const report: InstallBundlesReport = {
    installed: [],
    skipped: [],
    failed: [],
  }
  for (const [name, program] of Object.entries(opts.manifest.programs)) {
    const platformKey = pickPlatformKey(
      opts.platform,
      opts.arch,
      program.platforms
    )
    if (!platformKey) {
      report.skipped.push({
        name,
        reason: `no manifest entry for ${opts.platform}/${opts.arch}`,
      })
      continue
    }
    const entry = program.platforms[platformKey]
    if (!isUsableDownloadUrl(entry.download.url)) {
      // Operator hasn't filled in this entry yet (typical for the git
      // template). Treat as `skipped` so a partial manifest doesn't
      // fail the whole install and prevent node/python from being
      // staged.
      report.skipped.push({
        name,
        reason: `manifest entry has no usable download.url — operator must publish the asset and update bundles/manifest.json`,
      })
      continue
    }
    const rootDir = bundleRootDir(
      opts.toolchainDir,
      name,
      program.version,
      platformKey,
      opts.platform
    )
    if (opts.skipExisting && isHealthyCache(rootDir, entry, opts.platform)) {
      report.skipped.push({
        name,
        reason: `already installed at ${rootDir}`,
      })
      continue
    }
    try {
      const bytes = await downloadAndExtractEntry({
        entry,
        rootDir,
        platform: opts.platform,
        fetchImpl,
        log: (msg) => log(`[${name}] ${msg}`),
        prestageDirs: opts.prestageDirs,
        // Pushed down into downloadAndExtractEntry so the pre-staged
        // archive is read at most ONCE — the prior shape pre-validated
        // by reading the buffer here and then re-read it inside
        // downloadAndExtractEntry, doubling disk I/O on the 150+ MB
        // linux-x64 archives. Threading the flag through lets the
        // single-buffer-read path enforce the air-gapped requirement.
        requirePrestaged: opts.requirePrestaged,
        toolchainMirror: opts.toolchainMirror,
      })
      if (!isHealthyCache(rootDir, entry, opts.platform)) {
        throw new Error(
          `requiredFiles missing after extraction for ${name}@${program.version}`
        )
      }
      report.installed.push({
        name,
        version: program.version,
        platformKey,
        rootDir,
        bytes,
      })
      log(`[${name}] installed @ ${rootDir} (${bytes} bytes)`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report.failed.push({ name, reason: message })
      log(`[${name}] FAILED: ${message}`)
    }
  }
  return report
}

export interface DownloadAndExtractEntryOptions {
  entry: ManifestPlatformEntry
  rootDir: string
  platform: TerminalPlatform
  fetchImpl?: typeof fetch
  log?: (message: string) => void
  /**
   * Optional list of directories to check for a pre-staged archive named
   * `<sha256>.<archiveFormat>` (or `<sha256>`) before doing an HTTPS
   * fetch. Air-gapped operators populate one of these directories during
   * image build; the runtime then never hits the network. When the
   * pre-staged file's sha256 doesn't match the manifest entry's expected
   * sha256, the path is ignored (sha256 is the integrity gate, not the
   * filename).
   */
  prestageDirs?: readonly string[]
  /**
   * When true, refuse the HTTPS fallback entirely: require a pre-staged
   * archive that already matches the expected sha256. Throws if no
   * matching pre-stage candidate is found. Used by air-gapped operators
   * who must NEVER reach the network during deployment.
   */
  requirePrestaged?: boolean
  /**
   * China Node-dist mirror key. When set (and the entry URL is a canonical
   * https://nodejs.org/dist/ URL), the URL's full prefix is rewritten to the
   * mirror's base and trustedSource is set to the matching mirror key BEFORE
   * the supply-chain check — so only allow-listed mirror hosts are reachable
   * and the official per-entry sha256 still gates the downloaded bytes.
   * Defaults to process.env.SYNAPSE_DEVICE_TOOLCHAIN_MIRROR; pass explicitly
   * (incl. "") in tests. Only applies to a canonical nodejs.org/dist URL.
   */
  toolchainMirror?: string
}

/**
 * Returns true iff the manifest entry has a real, populated download URL.
 * Operator-incomplete entries (TODO-style placeholders or empty strings)
 * are filtered before any fetch attempt so a partial manifest doesn't
 * fail an install run and so runtime resolve can surface a clear error.
 */
export function isUsableDownloadUrl(url: string | undefined): boolean {
  if (!url) return false
  if (url.startsWith("TODO")) return false
  if (url.startsWith("<")) return false
  return true
}

/**
 * Locates a pre-staged archive for `entry` in any of `prestageDirs`. Returns
 * the buffer iff a candidate file's content sha256 matches the manifest
 * entry's expected sha256; otherwise returns null and the caller falls back
 * to HTTPS download. We deliberately ignore filename and trust ONLY the
 * sha256 — operators can name their archives anything, and a tampered
 * archive can't slip past the integrity gate.
 */
export function readPrestagedArchive(opts: {
  entry: ManifestPlatformEntry
  prestageDirs: readonly string[]
  log?: (message: string) => void
}): Buffer | null {
  const log = opts.log ?? (() => undefined)
  const expectedSha = opts.entry.sha256.toLowerCase()
  const candidates: string[] = []
  for (const dir of opts.prestageDirs) {
    if (!dir) continue
    if (!existsSync(dir)) continue
    candidates.push(
      join(dir, `${expectedSha}.${opts.entry.archiveFormat}`),
      join(dir, expectedSha)
    )
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let buf: Buffer
    try {
      buf = readFileSync(candidate)
    } catch (err) {
      log(`pre-staged candidate ${candidate} unreadable: ${String(err)}`)
      continue
    }
    const hash = createHash("sha256").update(buf).digest("hex").toLowerCase()
    if (hash !== expectedSha) {
      log(
        `pre-staged ${candidate} sha256 mismatch (got ${hash}, expected ${expectedSha}); ignoring`
      )
      continue
    }
    log(`using pre-staged archive ${candidate} (${buf.byteLength} bytes)`)
    return buf
  }
  return null
}

/**
 * Default pre-stage directories the operator can populate to skip HTTPS
 * fetches. Order matters — first hit wins.
 *
 *   1. `SYNAPSE_DEVICE_PRESTAGED_DIR`: explicit operator override (per
 *      deployment); preferred when running in a Docker image where the
 *      archives are baked at build time.
 *   2. `@synapse/device-runtime-bundles-<platformKey>` sidecar package's
 *      `bundles/` directory (see `resolveSidecarBundleDirs`). This is
 *      the standard cross-platform npm pattern (esbuild / swc / sharp)
 *      — per-platform sidecars are declared as optionalDependencies on
 *      `@synapse/device-runtime`, npm's `os`+`cpu` filters install only
 *      the matching one, and the runtime finds the archives via
 *      `node_modules/@synapse/...-<platformKey>/bundles/`. A fresh
 *      `npm install @synapse/device-runtime` on a $plat host is
 *      sufficient to make first-run exec_file succeed without ANY
 *      outbound network.
 *   3. `<package-root>/bundles/archives/`: convention so a custom-built
 *      `@synapse/device-runtime` tarball can also ship archives via
 *      `files` (see package.json). Less common than the sidecar path
 *      since it requires re-publishing the whole device-runtime
 *      package; kept for shops that don't want to manage a separate
 *      tarball per platform.
 */
export function defaultPrestageDirs(packageRoot?: string): string[] {
  const dirs: string[] = []
  const envOverride = process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"]
  if (envOverride && envOverride.length > 0) {
    dirs.push(envOverride)
  }
  for (const dir of resolveSidecarBundleDirs(packageRoot)) {
    dirs.push(dir)
  }
  if (packageRoot) {
    dirs.push(join(packageRoot, "bundles", "archives"))
  }
  return dirs
}

/**
 * Returns the bundles directories of every
 * @synapse/device-runtime-bundles-<platformKey> sidecar package that
 * the runtime can see, in host-platform-first order. Three lookup
 * strategies are tried; first hit per platformKey wins.
 *
 *   1. node_modules/@synapse/device-runtime-bundles-<key>/bundles/
 *      — the standard production path when @synapse/device-runtime is
 *      consumed via npm registry. npm's os/cpu filter on the optional
 *      dep ensures only the host-matching sidecar is fetched.
 *
 *   2. Monorepo dev path: walking up from the runtime's import.meta.url
 *      anchor, we look for sibling `packages/device-runtime-bundles-
 *      <key>/bundles/`. This lets the in-repo dev workflow find the
 *      committed archives without requiring npm to symlink the
 *      sidecars (they're intentionally NOT in the root workspaces
 *      list — top-level `os`/`cpu` on workspace packages trips npm 9
 *      EBADPLATFORM even when they're under optionalDependencies).
 *
 *   3. The caller-provided packageRoot, treated the same way as the
 *      module anchor.
 *
 * Returns [] if no sidecar is present. The runtime then falls back to
 * `bundles/archives` (if shipped with device-runtime) and finally
 * HTTPS. Exported so install-bundles + tests use the same lookup
 * order the runtime uses; never touches the network.
 */
export function resolveSidecarBundleDirs(packageRoot?: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // Match host platform first, then other arches; ToolchainManager
  // only consumes archives matching its expected sha256 so order
  // affects performance, not correctness.
  const platformKeysInPreferredOrder = sidecarPlatformKeysInHostOrder()
  const anchors: string[] = []
  if (packageRoot) anchors.push(packageRoot)
  try {
    anchors.push(fileURLToPath(import.meta.url))
  } catch {
    /* fall back to cwd anchor below */
  }
  if (anchors.length === 0) anchors.push(process.cwd())
  for (const anchor of anchors) {
    let cursor = anchor
    for (let depth = 0; depth < 12; depth++) {
      // Strategy 1+3: production-shape node_modules/@synapse/...
      const nodeModules = join(cursor, "node_modules", "@synapse")
      if (existsSync(nodeModules)) {
        for (const key of platformKeysInPreferredOrder) {
          const sidecarDir = join(
            nodeModules,
            `device-runtime-bundles-${key}`,
            "bundles"
          )
          if (existsSync(sidecarDir) && !seen.has(sidecarDir)) {
            seen.add(sidecarDir)
            out.push(sidecarDir)
          }
        }
      }
      // Strategy 2: monorepo-relative sibling `packages/device-
      // runtime-bundles-<key>/bundles/`. This is what dev + CI see
      // when the sidecars are committed under packages/ but NOT in
      // the workspaces array (workspaces + top-level os/cpu trip
      // npm 9 EBADPLATFORM). Looking for `packages/` as a marker so
      // we don't accidentally pick up unrelated dirs further up.
      const packagesDir = join(cursor, "packages")
      if (existsSync(packagesDir)) {
        for (const key of platformKeysInPreferredOrder) {
          const sidecarDir = join(
            packagesDir,
            `device-runtime-bundles-${key}`,
            "bundles"
          )
          if (existsSync(sidecarDir) && !seen.has(sidecarDir)) {
            seen.add(sidecarDir)
            out.push(sidecarDir)
          }
        }
      }
      const parent = join(cursor, "..")
      if (parent === cursor) break
      cursor = parent
    }
  }
  return out
}

function sidecarPlatformKeysInHostOrder(): string[] {
  const all = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
    "win32-arm64",
  ]
  const hostKey = `${process.platform}-${process.arch}`
  const ordered = all.filter((k) => k === hostKey)
  for (const k of all) {
    if (k !== hostKey) ordered.push(k)
  }
  return ordered
}

/**
 * Download + sha256 + extract one manifest entry. Called by install-bundles
 * for the eager case and by ToolchainManager.resolve for the runtime
 * auto-download case. Writes the verified sha256 into the completion
 * marker so isHealthyCache can invalidate stale caches when the expected
 * sha256 changes (e.g. operator bumps the manifest entry's version).
 *
 * If `prestageDirs` is set, attempts to load the archive from local disk
 * first (air-gapped path). The sha256 verification is identical between
 * the HTTPS and local paths; a bad pre-staged file simply triggers the
 * HTTPS fallback rather than a hard failure.
 */
export async function downloadAndExtractEntry(
  opts: DownloadAndExtractEntryOptions
): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.log ?? (() => undefined)
  if (!isUsableDownloadUrl(opts.entry.download.url)) {
    throw new Error(
      `manifest entry has no usable download.url — operator must publish the asset and update bundles/manifest.json`
    )
  }
  // China-mirror prefix rewrite (default from env), BEFORE the supply-chain
  // guard so the rewritten host must itself be allow-listed. No-op unless a
  // known mirror key is set and the URL is canonical nodejs.org/dist.
  const mirrorKey =
    opts.toolchainMirror ?? process.env["SYNAPSE_DEVICE_TOOLCHAIN_MIRROR"]
  const entry = rewriteToNodeMirror(opts.entry, mirrorKey)
  if (entry.download.url !== opts.entry.download.url) {
    log(`mirror: ${opts.entry.download.url} -> ${entry.download.url}`)
  }
  // Supply-chain guard: hostname must be on the trustedSource allow-list.
  // Rejecting here means a tampered manifest can't redirect downloads to
  // an attacker's mirror. Applies even to the pre-staged path: the
  // manifest still has to declare an allow-listed URL even though we
  // won't fetch it, so operators can't whitelist `fixture://attacker` to
  // sneak an unverified archive in.
  assertTrustedDownload(entry)
  let buf: Buffer | null = null
  if (opts.prestageDirs && opts.prestageDirs.length > 0) {
    buf = readPrestagedArchive({
      entry,
      prestageDirs: opts.prestageDirs,
      log,
    })
  }
  if (buf === null) {
    if (opts.requirePrestaged) {
      // Air-gapped mode: no HTTPS fallback. Caller must populate one of
      // prestageDirs with a sha256-matching archive. Bail with a useful
      // diagnostic — listing the searched directories so the operator
      // knows where to drop the file.
      const searched = (opts.prestageDirs ?? []).join(", ") || "<empty>"
      throw new Error(
        `--require-prestaged set but no sha256-matching archive found in [${searched}]`
      )
    }
    log(`GET ${entry.download.url}`)
    const res = await fetchImpl(entry.download.url)
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`)
    }
    buf = Buffer.from(await res.arrayBuffer())
  }
  const hash = createHash("sha256").update(buf).digest("hex")
  if (hash.toLowerCase() !== opts.entry.sha256.toLowerCase()) {
    throw new Error(
      `sha256 mismatch: expected ${opts.entry.sha256} got ${hash}`
    )
  }
  rmSync(opts.rootDir, { recursive: true, force: true })
  mkdirSync(opts.rootDir, { recursive: true })
  if (opts.entry.archiveFormat === "tar.gz") {
    await new Promise<void>((resolve, reject) => {
      Readable.from(buf as Buffer)
        .pipe(
          tarExtract({ cwd: opts.rootDir, strip: opts.entry.stripComponents })
        )
        .on("end", () => resolve())
        .on("finish", () => resolve())
        .on("error", reject)
    })
  } else if (opts.entry.archiveFormat === "zip") {
    await extractZip({
      buffer: buf as Buffer,
      rootDir: opts.rootDir,
      stripComponents: opts.entry.stripComponents,
      platform: opts.platform,
    })
  } else {
    // Schema currently restricts archiveFormat to the two cases above; this
    // branch exists so a future schema bump doesn't silently fall through
    // to a no-op extraction (which would then trip requiredFiles checking
    // with a confusing "file missing" error far from the real cause).
    throw new Error(
      `unsupported archiveFormat: ${String(opts.entry.archiveFormat)}`
    )
  }
  // COMPLETION_MARKER is a Synapse-internal filename (no `..`, no
  // separators) so the host-path join is safe; we don't need
  // platform-aware escape validation here. Using host `join` lets cross-
  // prep (Linux operator → win32 target) write the marker successfully.
  writeFileSync(join(opts.rootDir, COMPLETION_MARKER), hash)
  return buf.byteLength
}

/**
 * Extract a zip archive (in-memory buffer) into rootDir. Mirrors the
 * safety guarantees of the tar path: every entry is resolved via
 * joinUnderRoot so a malicious zip with `../` entries can't escape, and
 * stripComponents drops N leading path segments (matching `tar
 * --strip-components`). Used for MinGit (git-for-windows ships only zip
 * archives) and any future Windows-native asset.
 *
 * Escape validation uses the manifest-declared `platform` (so an
 * archive shipped for win32 gets win32 path semantics in the
 * isPathInside check), but the actual file writes use the HOST's
 * `node:path` join — so cross-prepping (Linux operator running
 * `install-bundles --platform=win32-x64`) lands extracted bytes in a
 * directory the local fs can mkdir + write. At runtime on the actual
 * target device, host == platform, so this distinction is a no-op.
 */
async function extractZip(params: {
  buffer: Buffer
  rootDir: string
  stripComponents: number
  platform: TerminalPlatform
}): Promise<void> {
  const directory = await unzipper.Open.buffer(params.buffer)
  for (const entry of directory.files) {
    if (entry.type === "Directory") continue
    const segments = entry.path.split(/\/|\\/).filter((s) => s.length > 0)
    if (segments.length <= params.stripComponents) {
      // Leading-path-only entry; nothing to write after the strip.
      continue
    }
    const stripped = segments.slice(params.stripComponents).join("/")
    // joinUnderRoot rejects `..` / absolute escapes (platform-aware
    // semantics); on success we drop back to host path for fs ops.
    joinUnderRoot(params.rootDir, stripped, params.platform)
    const absoluteHostPath = join(
      params.rootDir,
      ...segments.slice(params.stripComponents)
    )
    if (!isPathInside(params.rootDir, absoluteHostPath, params.platform)) {
      throw new Error(
        `zip entry ${entry.path} resolves outside rootDir; refusing`
      )
    }
    mkdirSync(dirnameOf(absoluteHostPath), { recursive: true })
    const stream = entry.stream()
    await pipeline(stream, createWriteStream(absoluteHostPath))
    // Best-effort exec bit on POSIX when zip declares one. Windows-only
    // archives (e.g. MinGit) carry .exe and don't rely on mode bits;
    // POSIX zips that bundle scripts get the bits they declared.
    if (params.platform !== "win32") {
      const mode = (entry.externalFileAttributes ?? 0) >>> 16
      if ((mode & 0o111) !== 0) {
        try {
          chmodSync(absoluteHostPath, mode & 0o777)
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

export function pickPlatformKey(
  platform: TerminalPlatform,
  arch: string,
  available: Record<string, ManifestPlatformEntry>
): string | null {
  // Strict match — see toolchain-manager.ts:pickPlatformKey for rationale.
  // The two implementations stay in sync; tests in
  // src/terminal/toolchain-manager.test.ts cover the cross-arch case.
  const candidates = PLATFORM_KEYS[platform] ?? []
  for (const key of candidates) {
    if (key === `${platform}-${arch}` && available[key]) {
      return key
    }
  }
  return null
}

/**
 * Cache healthy iff:
 *   1. marker file exists
 *   2. marker CONTAINS the currently-expected sha256 (so a manifest bump
 *      invalidates stale extracted bytes)
 *   3. every requiredFile + executable exists and lives under rootDir
 */
export function isHealthyCache(
  rootDir: string,
  entry: ManifestPlatformEntry,
  platform: TerminalPlatform
): boolean {
  // Marker is a Synapse-internal filename; host join is safe.
  const markerPath = join(rootDir, COMPLETION_MARKER)
  if (!existsSync(markerPath)) return false
  let markerContent: string
  try {
    markerContent = readFileSync(markerPath, "utf-8").trim()
  } catch {
    return false
  }
  if (markerContent.toLowerCase() !== entry.sha256.toLowerCase()) {
    return false
  }
  for (const rel of [entry.executable, ...entry.requiredFiles]) {
    // Two-step: platform-aware escape validation (manifest input,
    // hostile possible) → host fs lookup. Mirrors extractZip /
    // bundleRootDir reasoning.
    try {
      joinUnderRoot(rootDir, rel, platform)
    } catch {
      return false
    }
    const segments = rel.split(/\/|\\/).filter((s) => s.length > 0)
    const absoluteHostPath = join(rootDir, ...segments)
    if (!isPathInside(rootDir, absoluteHostPath, platform)) return false
    if (!existsSync(absoluteHostPath)) return false
  }
  return true
}

/** Reasons that count as a "healthy" skip (program is already usable). */
export const HEALTHY_SKIP_REASON_PREFIX = "already installed"

/**
 * Did the install report leave the device with at least one usable
 * managed toolchain? Used by the CLI to decide whether `install-bundles`
 * exit code 0 is honest or whether the operator was misled by "all
 * skipped" success. A program whose manifest entry is missing for the
 * target platform/arch (or has a TODO download.url) is an UNHEALTHY skip;
 * a program already installed (skipExisting hit) is healthy.
 */
export function summarizeInstallReport(report: InstallBundlesReport): {
  installedCount: number
  healthySkippedCount: number
  unhealthySkippedCount: number
  failedCount: number
  /** Any program ended up usable on disk (either newly installed or cached). */
  anyUsable: boolean
} {
  const installedCount = report.installed.length
  let healthySkippedCount = 0
  let unhealthySkippedCount = 0
  for (const s of report.skipped) {
    if (s.reason.startsWith(HEALTHY_SKIP_REASON_PREFIX)) {
      healthySkippedCount++
    } else {
      unhealthySkippedCount++
    }
  }
  return {
    installedCount,
    healthySkippedCount,
    unhealthySkippedCount,
    failedCount: report.failed.length,
    anyUsable: installedCount > 0 || healthySkippedCount > 0,
  }
}

export { parseToolchainManifest, UntrustedDownloadSourceError }
