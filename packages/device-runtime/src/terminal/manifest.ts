// Manifest schema for bundled toolchains. The same schema is consumed by
// `synapse-device install-bundles` (eager download/extract) and by
// ToolchainManager.resolve (runtime cache hit + archive extract).
//
// All paths in manifest entries (executable / binDir / requiredFiles / env
// template values) are RELATIVE to the per-entry root directory
// `<toolchainDir>/<name>-<version>/`. The loader resolves them to absolute
// paths via `joinUnderRoot` so a malicious manifest using `../` cannot
// escape the toolchain root.
//
// Supply chain: download.url MUST match one of the trustedSource entries
// below. v1 = upstream-pinning (sha256 verified + hostname allow-listed),
// NOT inline-shipped binaries. The npm tarball stays small; first-run
// fetches go to a vetted upstream over HTTPS, and a compromised manifest
// can't redirect to an attacker's mirror because the hostname is checked
// before the request goes out.

import { z } from "zod"

/**
 * Allow-listed provenance sources. Adding an entry here is a deliberate
 * supply-chain decision — the new hostname is now trusted to serve
 * binaries Synapse runs on user devices. Adding "synapse-published"
 * entries requires Synapse-controlled hosting + a build script in
 * bundles/build-scripts/.
 *
 * `urlPrefixes` is REQUIRED for any source whose hostname is shared with
 * arbitrary third parties (e.g. github.com / release-assets.github
 * usercontent.com — anyone can publish releases there). Without prefix
 * matching, a tampered manifest could swap
 * `astral-sh/python-build-standalone` for
 * `not-astral/malicious` and still pass the hostname check. Hostname-only
 * sources (e.g. nodejs.org) can omit urlPrefixes.
 */
export const TRUSTED_SOURCES = {
  "nodejs.org-official": {
    hostnames: ["nodejs.org"],
    urlPrefixes: ["https://nodejs.org/dist/"],
    description: "Official Node.js release tarballs.",
  },
  // China Node-dist mirrors. Each lays out vXX.YY.ZZ/<file> + SHASUMS256.txt
  // byte-identically to nodejs.org/dist, so the per-entry sha256 still gates
  // the bytes after a host rewrite (see rewriteToNodeMirror in bundles/
  // install.ts). The urlPrefixes match each mirror's REAL base path — they
  // differ per host (/node/ vs /nodejs/ vs /nodejs-release/ vs /binaries/
  // node/), so a host-only swap would not pass this guard. Selected via
  // SYNAPSE_DEVICE_TOOLCHAIN_MIRROR; node-only (python/git mirrors are out of
  // scope — they lack the same byte-identical guarantee). TUNA is deliberately
  // NOT listed: its nodejs-release mirror is frozen and 404s on recent LTS.
  "nodejs.org-ustc": {
    hostnames: ["mirrors.ustc.edu.cn"],
    urlPrefixes: ["https://mirrors.ustc.edu.cn/node/"],
    description: "USTC Node.js mirror (China).",
  },
  "nodejs.org-huawei": {
    hostnames: ["mirrors.huaweicloud.com"],
    urlPrefixes: ["https://mirrors.huaweicloud.com/nodejs/"],
    description: "Huawei Cloud Node.js mirror (China).",
  },
  "nodejs.org-tencent": {
    hostnames: ["mirrors.cloud.tencent.com"],
    urlPrefixes: ["https://mirrors.cloud.tencent.com/nodejs-release/"],
    description: "Tencent Cloud Node.js mirror (China).",
  },
  "nodejs.org-aliyun": {
    hostnames: ["mirrors.aliyun.com"],
    urlPrefixes: ["https://mirrors.aliyun.com/nodejs-release/"],
    description: "Aliyun Node.js mirror (China).",
  },
  "nodejs.org-npmmirror": {
    hostnames: ["cdn.npmmirror.com"],
    urlPrefixes: ["https://cdn.npmmirror.com/binaries/node/"],
    description: "npmmirror (Taobao) Node.js binary mirror (China).",
  },
  "astral-sh-python-build-standalone": {
    // Manifest URLs MUST be the canonical github.com/astral-sh/python-
    // build-standalone/releases/... form. GitHub's signed-asset
    // redirect hosts (release-assets.githubusercontent.com /
    // objects.githubusercontent.com) are NOT listed here, even though
    // the actual fetch ends up there — they're multi-tenant and a
    // path-prefix can't bind them to astral-sh.
    //
    // The HTTP client follows the 302 from github.com to the signed
    // asset URL automatically; that signed URL is GitHub-controlled,
    // bound to the original release by signature parameters, and the
    // sha256 check after download is the final byte-level guard
    // anyway. So this is safe even though the post-redirect URL
    // doesn't pass through assertTrustedDownload — it's a different
    // request issued by the runtime, not a URL the manifest gets to
    // specify.
    hostnames: ["github.com"],
    urlPrefixes: [
      "https://github.com/astral-sh/python-build-standalone/releases/",
    ],
    description:
      "astral-sh/python-build-standalone GitHub releases (vetted PSF-2.0 build).",
  },
  "git-for-windows": {
    // Same multi-tenant-host rationale as astral-sh above: hostname is
    // github.com but the urlPrefix binds the trusted source to the
    // git-for-windows org's releases. Used for Windows MinGit (the
    // official portable git distribution for Windows x64 + arm64;
    // GPL-2.0). Linux/Darwin git is NOT served by this source — git-
    // for-windows ships only Windows binaries; bundle eligibility for
    // git on non-Windows platforms therefore stays off (see
    // BUNDLE_PROGRAM_PLATFORM_KEYS.git).
    hostnames: ["github.com"],
    urlPrefixes: ["https://github.com/git-for-windows/git/releases/"],
    description:
      "git-for-windows official releases (MinGit / PortableGit, GPL-2.0).",
  },
  "synapse-published": {
    // Filled in once Synapse maintains its own release/CDN host. Until
    // then operators MUST NOT use this trustedSource value.
    hostnames: ["releases.synapse.example", "cdn.synapse.example"],
    urlPrefixes: [
      "https://releases.synapse.example/device-runtime/",
      "https://cdn.synapse.example/device-runtime/",
    ],
    description: "Synapse-controlled release asset (e.g. self-built git).",
  },
  "fixture-test": {
    // Test fixture archives use the "fixture://" pseudo-URL scheme; the
    // hostname check is bypassed in tests via TRUSTED_SOURCE_FIXTURE_OK.
    hostnames: [],
    urlPrefixes: ["fixture://"],
    description: "Test fixture archive — not for production use.",
  },
} as const

export type TrustedSourceKey = keyof typeof TRUSTED_SOURCES

export const ManifestArchiveFormatSchema = z.enum(["tar.gz", "zip"])
export type ManifestArchiveFormat = z.infer<typeof ManifestArchiveFormatSchema>

export const ManifestDownloadSchema = z.object({
  url: z.string().min(1),
  license: z.string().optional(),
  /**
   * Required since schemaVersion 1.1. Must match a key in TRUSTED_SOURCES.
   * Older manifests without this field are accepted but every entry's
   * download URL hostname must still match the inferred trustedSource
   * (see inferTrustedSourceFromUrl).
   */
  trustedSource: z
    .enum(
      Object.keys(TRUSTED_SOURCES) as [TrustedSourceKey, ...TrustedSourceKey[]]
    )
    .optional(),
})
export type ManifestDownload = z.infer<typeof ManifestDownloadSchema>

export const ManifestPlatformEntrySchema = z.object({
  sha256: z.string().min(1),
  download: ManifestDownloadSchema,
  archiveFormat: ManifestArchiveFormatSchema.default("tar.gz"),
  /** tar --strip-components value; defaults to 0 (keep all leading dirs). */
  stripComponents: z.number().int().min(0).max(8).default(0),
  /** Relative path to the executable that runs the tool, e.g. "bin/node". */
  executable: z.string().min(1),
  /** Relative path to the directory we prepend to PATH for sub-processes. */
  binDir: z.string().min(1),
  /** Files we must observe under rootDir before claiming the toolchain is healthy. */
  requiredFiles: z.array(z.string().min(1)).default([]),
  /**
   * Extra environment variables to inject into spawned children when this
   * toolchain is the one we ship. Values may contain the literal `{rootDir}`
   * token which is replaced with the absolute extracted root at resolve time.
   * These come from a trusted manifest, so they are NOT subject to
   * DANGEROUS_ENV_KEYS stripping inside the executor.
   */
  env: z.record(z.string(), z.string()).default({}),
})
export type ManifestPlatformEntry = z.infer<typeof ManifestPlatformEntrySchema>

export const ManifestProgramSchema = z.object({
  version: z.string().min(1),
  platforms: z.record(z.string(), ManifestPlatformEntrySchema),
})
export type ManifestProgram = z.infer<typeof ManifestProgramSchema>

export const ToolchainManifestSchema = z.object({
  schemaVersion: z.literal(1),
  // Map of normalized program name (e.g. "node", "python", "git") -> spec.
  // Keys are matched against `normalizeProgramName(...)` at resolve time.
  // Use `.passthrough()` would be looser; instead expose a strongly-typed
  // record so unknown top-level keys cause loader to surface them clearly.
  programs: z.record(z.string(), ManifestProgramSchema),
})
export type ToolchainManifest = z.infer<typeof ToolchainManifestSchema>

export function parseToolchainManifest(raw: unknown): ToolchainManifest {
  return ToolchainManifestSchema.parse(raw)
}

/**
 * Throws if the manifest entry's download.url isn't on the hostname
 * allow-list for its declared trustedSource. Called by both
 * install-bundles' eager loop and ToolchainManager.resolve's auto-
 * download path so a compromised manifest can't redirect to an
 * attacker's mirror. v1 contract: HTTPS only, hostname must be in
 * TRUSTED_SOURCES[trustedSource].hostnames.
 *
 * `fixture://` pseudo-URLs are accepted only when entry.trustedSource
 * === "fixture-test" — keeps test ergonomics intact without weakening
 * the production guard.
 */
export class UntrustedDownloadSourceError extends Error {
  readonly name = "UntrustedDownloadSourceError"
  constructor(
    public readonly url: string,
    public readonly reason: string
  ) {
    super(`untrusted download source for ${url}: ${reason}`)
  }
}

export function assertTrustedDownload(entry: ManifestPlatformEntry): void {
  const url = entry.download.url
  if (
    entry.download.trustedSource === "fixture-test" &&
    url.startsWith("fixture://")
  ) {
    return
  }
  if (!url.startsWith("https://")) {
    throw new UntrustedDownloadSourceError(url, "url must use https://")
  }
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    throw new UntrustedDownloadSourceError(url, "url not parseable")
  }
  const trustedSource = entry.download.trustedSource
  if (trustedSource) {
    const src = TRUSTED_SOURCES[trustedSource]
    const allowedHosts = src.hostnames as readonly string[]
    if (allowedHosts.length === 0) {
      throw new UntrustedDownloadSourceError(
        url,
        `trustedSource ${trustedSource} has no production hostnames`
      )
    }
    if (!allowedHosts.includes(hostname)) {
      throw new UntrustedDownloadSourceError(
        url,
        `hostname ${hostname} not in TRUSTED_SOURCES[${trustedSource}].hostnames (${allowedHosts.join(", ")})`
      )
    }
    // Prefix check — the critical guard for multi-tenant hosts (e.g.
    // github.com hosts anyone's releases; only astral-sh/python-build-
    // standalone is trusted).
    const allowedPrefixes = src.urlPrefixes as readonly string[]
    if (allowedPrefixes.length > 0) {
      const ok = allowedPrefixes.some((p) => url.startsWith(p))
      if (!ok) {
        throw new UntrustedDownloadSourceError(
          url,
          `url does not start with any TRUSTED_SOURCES[${trustedSource}].urlPrefixes (${allowedPrefixes.join(", ")})`
        )
      }
    }
    return
  }
  // No declared trustedSource — accept iff hostname AND url prefix both
  // match some trusted source. Back-compat for manifests authored before
  // the trustedSource field existed; the implicit fallback never adds
  // new trusted hosts/prefixes.
  for (const src of Object.values(TRUSTED_SOURCES)) {
    const hosts = src.hostnames as readonly string[]
    const prefixes = src.urlPrefixes as readonly string[]
    if (!hosts.includes(hostname)) continue
    if (prefixes.length === 0) return
    if (prefixes.some((p) => url.startsWith(p))) return
  }
  throw new UntrustedDownloadSourceError(
    url,
    `url ${url} matches no TRUSTED_SOURCES entry (hostname=${hostname})`
  )
}
