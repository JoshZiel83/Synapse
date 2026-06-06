import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  assertTrustedDownload,
  parseToolchainManifest,
  TRUSTED_SOURCES,
  UntrustedDownloadSourceError,
} from "./manifest.js"
import {
  BUNDLE_ELIGIBLE_PROGRAMS,
  BUNDLE_PROGRAM_PLATFORM_KEYS,
} from "@synapse/shared"

test("assertTrustedDownload: https + nodejs.org allowed", () => {
  assertTrustedDownload({
    sha256: "x",
    download: {
      url: "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz",
      trustedSource: "nodejs.org-official",
    },
    archiveFormat: "tar.gz",
    stripComponents: 1,
    executable: "bin/node",
    binDir: "bin",
    requiredFiles: ["bin/node"],
    env: {},
  })
})

test("assertTrustedDownload: https + python-build-standalone github host allowed", () => {
  assertTrustedDownload({
    sha256: "x",
    download: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.12.13+20260510-x86_64-unknown-linux-gnu-install_only.tar.gz",
      trustedSource: "astral-sh-python-build-standalone",
    },
    archiveFormat: "tar.gz",
    stripComponents: 0,
    executable: "python/bin/python3",
    binDir: "python/bin",
    requiredFiles: [],
    env: {},
  })
})

test("assertTrustedDownload: rejects http:// (must be https)", () => {
  assert.throws(
    () =>
      assertTrustedDownload({
        sha256: "x",
        download: {
          url: "http://nodejs.org/dist/v22.11.0/node.tar.gz",
          trustedSource: "nodejs.org-official",
        },
        archiveFormat: "tar.gz",
        stripComponents: 1,
        executable: "bin/node",
        binDir: "bin",
        requiredFiles: [],
        env: {},
      }),
    (err) =>
      err instanceof UntrustedDownloadSourceError &&
      /https:\/\//.test(err.message)
  )
})

test("assertTrustedDownload: rejects hostname not in trustedSource allow-list", () => {
  assert.throws(
    () =>
      assertTrustedDownload({
        sha256: "x",
        download: {
          // typo-squatting attempt: nodejs.org.evil.com
          url: "https://nodejs.org.evil.com/node.tar.gz",
          trustedSource: "nodejs.org-official",
        },
        archiveFormat: "tar.gz",
        stripComponents: 1,
        executable: "bin/node",
        binDir: "bin",
        requiredFiles: [],
        env: {},
      }),
    (err) => err instanceof UntrustedDownloadSourceError
  )
})

test("assertTrustedDownload: rejects synapse-published in v1 (no production host configured)", () => {
  // Until Synapse maintains its own release host, the synapse-published
  // entry's hostnames are placeholders — the matcher should refuse to
  // download from them (operator MUST update both the manifest entry
  // and TRUSTED_SOURCES.synapse-published.hostnames together).
  assert.throws(
    () =>
      assertTrustedDownload({
        sha256: "x",
        download: {
          url: "https://attacker.example/git.tar.gz",
          trustedSource: "synapse-published",
        },
        archiveFormat: "tar.gz",
        stripComponents: 0,
        executable: "bin/git",
        binDir: "bin",
        requiredFiles: [],
        env: {},
      }),
    (err) => err instanceof UntrustedDownloadSourceError
  )
})

test("assertTrustedDownload: fixture-test only accepted with fixture:// URL", () => {
  // Legitimate fixture usage:
  assertTrustedDownload({
    sha256: "x",
    download: {
      url: "fixture://fake-git",
      trustedSource: "fixture-test",
    },
    archiveFormat: "tar.gz",
    stripComponents: 0,
    executable: "bin/fake",
    binDir: "bin",
    requiredFiles: [],
    env: {},
  })
  // fixture-test trustedSource with NON-fixture URL — rejected so a
  // production manifest can't mark a hostile URL as a "fixture".
  assert.throws(
    () =>
      assertTrustedDownload({
        sha256: "x",
        download: {
          url: "https://attacker.example/fake-git",
          trustedSource: "fixture-test",
        },
        archiveFormat: "tar.gz",
        stripComponents: 0,
        executable: "bin/fake",
        binDir: "bin",
        requiredFiles: [],
        env: {},
      }),
    (err) => err instanceof UntrustedDownloadSourceError
  )
})

test("assertTrustedDownload: missing trustedSource accepts known hostnames (back-compat)", () => {
  // Manifests authored before the trustedSource field existed: a known
  // hostname still passes; an unknown one still fails.
  assertTrustedDownload({
    sha256: "x",
    download: {
      url: "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz",
    },
    archiveFormat: "tar.gz",
    stripComponents: 1,
    executable: "bin/node",
    binDir: "bin",
    requiredFiles: [],
    env: {},
  })
  assert.throws(
    () =>
      assertTrustedDownload({
        sha256: "x",
        download: {
          url: "https://random.example/something.tar.gz",
        },
        archiveFormat: "tar.gz",
        stripComponents: 1,
        executable: "bin/x",
        binDir: "bin",
        requiredFiles: [],
        env: {},
      }),
    (err) => err instanceof UntrustedDownloadSourceError
  )
})

test("parseToolchainManifest: production manifest entries declare trustedSource", () => {
  // Defense-in-depth: parsing the actual production manifest succeeds AND
  // every download entry asserts trusted (no entry slipped in without
  // explicit provenance).
  const here = dirname(fileURLToPath(import.meta.url))
  const manifestPath = join(here, "..", "..", "bundles", "manifest.json")
  const raw = readFileSync(manifestPath, "utf-8")
  const manifest = parseToolchainManifest(JSON.parse(raw))
  for (const [name, program] of Object.entries(manifest.programs)) {
    for (const [key, entry] of Object.entries(program.platforms)) {
      assertTrustedDownload(
        entry as Parameters<typeof assertTrustedDownload>[0]
      )
      assert.ok(
        (entry as { download: { trustedSource?: string } }).download
          .trustedSource,
        `${name}.${key} missing explicit trustedSource`
      )
    }
  }
})

test("assertTrustedDownload: github.com URL must start with astral-sh path prefix", () => {
  // Regression: prior version only checked hostname, so
  // https://github.com/not-astral/malicious/releases/... would pass.
  assert.throws(
    () =>
      assertTrustedDownload({
        sha256: "x",
        download: {
          url: "https://github.com/not-astral/malicious/releases/download/v1/a.tar.gz",
          trustedSource: "astral-sh-python-build-standalone",
        },
        archiveFormat: "tar.gz",
        stripComponents: 0,
        executable: "python/bin/python3",
        binDir: "python/bin",
        requiredFiles: [],
        env: {},
      }),
    (err) =>
      err instanceof UntrustedDownloadSourceError &&
      /does not start with any.*urlPrefixes/.test(err.message)
  )
})

test("assertTrustedDownload: github.com URL with astral-sh prefix is allowed", () => {
  assertTrustedDownload({
    sha256: "x",
    download: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.12.13+20260510-x86_64-unknown-linux-gnu-install_only.tar.gz",
      trustedSource: "astral-sh-python-build-standalone",
    },
    archiveFormat: "tar.gz",
    stripComponents: 0,
    executable: "python/bin/python3",
    binDir: "python/bin",
    requiredFiles: [],
    env: {},
  })
})

test("assertTrustedDownload: release-assets.githubusercontent.com no longer a trusted hostname", () => {
  // Regression: an earlier draft accepted release-assets.githubusercontent.com
  // and objects.githubusercontent.com as trusted hostnames for the python-
  // build-standalone source. Those are multi-tenant signed-asset hosts ("/<anything>/<sig>")
  // — anyone with a github release can serve from them. The HTTP client
  // follows the 302 from github.com automatically; manifests must declare
  // the canonical github.com URL, never the post-redirect URL.
  for (const url of [
    "https://release-assets.githubusercontent.com/attacker/path.tar.gz",
    "https://objects.githubusercontent.com/attacker/path.tar.gz",
  ]) {
    assert.throws(
      () =>
        assertTrustedDownload({
          sha256: "x",
          download: {
            url,
            trustedSource: "astral-sh-python-build-standalone",
          },
          archiveFormat: "tar.gz",
          stripComponents: 0,
          executable: "python/bin/python3",
          binDir: "python/bin",
          requiredFiles: [],
          env: {},
        }),
      (err) => err instanceof UntrustedDownloadSourceError,
      `${url} must be rejected`
    )
  }
})

test("assertTrustedDownload: nodejs.org URL outside /dist/ rejected", () => {
  assert.throws(
    () =>
      assertTrustedDownload({
        sha256: "x",
        download: {
          // Hostname matches but path doesn't match the nodejs.org /dist/
          // prefix — must reject.
          url: "https://nodejs.org/some/other/path/node.tar.gz",
          trustedSource: "nodejs.org-official",
        },
        archiveFormat: "tar.gz",
        stripComponents: 1,
        executable: "bin/node",
        binDir: "bin",
        requiredFiles: [],
        env: {},
      }),
    (err) => err instanceof UntrustedDownloadSourceError
  )
})

test("assertTrustedDownload: git-for-windows URL with allowed prefix is accepted", () => {
  // MinGit ships at the canonical git-for-windows release URL. The
  // trustedSource binds the github.com host to the git-for-windows
  // org's releases via urlPrefixes; substituting an attacker org must
  // be rejected (regression on the analogous astral-sh case).
  assertTrustedDownload({
    sha256: "x",
    download: {
      url: "https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/MinGit-2.54.0-64-bit.zip",
      trustedSource: "git-for-windows",
    },
    archiveFormat: "zip",
    stripComponents: 0,
    executable: "cmd/git.exe",
    binDir: "cmd",
    requiredFiles: ["cmd/git.exe"],
    env: {},
  })
})

test("assertTrustedDownload: git-for-windows trustedSource rejects non-git-for-windows org", () => {
  assert.throws(
    () =>
      assertTrustedDownload({
        sha256: "x",
        download: {
          url: "https://github.com/attacker-fork/git/releases/download/v1/MinGit.zip",
          trustedSource: "git-for-windows",
        },
        archiveFormat: "zip",
        stripComponents: 0,
        executable: "cmd/git.exe",
        binDir: "cmd",
        requiredFiles: ["cmd/git.exe"],
        env: {},
      }),
    (err) =>
      err instanceof UntrustedDownloadSourceError &&
      /does not start with any.*urlPrefixes/.test(err.message)
  )
})

test("TRUSTED_SOURCES: every key documents its hostnames + description", () => {
  for (const [key, src] of Object.entries(TRUSTED_SOURCES)) {
    assert.equal(typeof src.description, "string")
    assert.ok(src.description.length > 0, `${key} missing description`)
    assert.ok(Array.isArray(src.hostnames))
  }
})

test("manifest ↔ BUNDLE_PROGRAM_PLATFORM_KEYS parity: shared gate and bundles/manifest.json declare the same matrix", () => {
  // Drift between the API's grant gate (@synapse/shared) and the device-
  // runtime manifest is exactly the "approved but unrunnable" bug we keep
  // closing. This test makes it loud:
  //
  //   * Every (program, platformKey) the API claims is bundle-fallback-able
  //     MUST appear in the production manifest with a real download URL.
  //   * Every program in the manifest MUST appear in
  //     BUNDLE_ELIGIBLE_PROGRAMS (or be removed from the manifest) so the
  //     device never extracts a toolchain the API doesn't gate.
  //
  // If you add a Windows or arm entry to either side, this test forces the
  // other side to follow in the same PR.
  const here = dirname(fileURLToPath(import.meta.url))
  const manifestPath = join(here, "..", "..", "bundles", "manifest.json")
  const manifest = parseToolchainManifest(
    JSON.parse(readFileSync(manifestPath, "utf-8"))
  )
  // Forward direction: every API-claimed (program, key) is in the manifest.
  for (const program of BUNDLE_ELIGIBLE_PROGRAMS) {
    const manifestEntry = manifest.programs[program]
    assert.ok(
      manifestEntry,
      `${program} is BUNDLE_ELIGIBLE but missing from bundles/manifest.json`
    )
    const claimedKeys = BUNDLE_PROGRAM_PLATFORM_KEYS[program] ?? []
    for (const key of claimedKeys) {
      const platformEntry = manifestEntry.platforms[key]
      assert.ok(
        platformEntry,
        `${program}.${key} claimed by BUNDLE_PROGRAM_PLATFORM_KEYS but missing in manifest`
      )
      assert.ok(
        platformEntry.download.url.length > 0 &&
          !platformEntry.download.url.startsWith("TODO") &&
          !platformEntry.download.url.startsWith("<"),
        `${program}.${key} claimed by API gate but manifest URL is a placeholder`
      )
    }
  }
  // Reverse direction: every manifest (program, key) is API-gated.
  for (const [program, programEntry] of Object.entries(manifest.programs)) {
    assert.ok(
      BUNDLE_ELIGIBLE_PROGRAMS.includes(program),
      `${program} appears in manifest but not in BUNDLE_ELIGIBLE_PROGRAMS — API will never grant fallback`
    )
    const claimedKeys = BUNDLE_PROGRAM_PLATFORM_KEYS[program] ?? []
    for (const key of Object.keys(programEntry.platforms)) {
      assert.ok(
        claimedKeys.includes(key as (typeof claimedKeys)[number]),
        `${program}.${key} in manifest but BUNDLE_PROGRAM_PLATFORM_KEYS doesn't list it — API will refuse the grant`
      )
    }
  }
})

// --- China Node-dist mirror trusted sources (P5) ---------------------------
const CN_MIRROR_CASES: Array<{ key: string; url: string }> = [
  {
    key: "nodejs.org-ustc",
    url: "https://mirrors.ustc.edu.cn/node/v24.16.0/node-v24.16.0-linux-x64.tar.gz",
  },
  {
    key: "nodejs.org-huawei",
    url: "https://mirrors.huaweicloud.com/nodejs/v24.16.0/node-v24.16.0-linux-x64.tar.gz",
  },
  {
    key: "nodejs.org-tencent",
    url: "https://mirrors.cloud.tencent.com/nodejs-release/v24.16.0/node-v24.16.0-linux-x64.tar.gz",
  },
  {
    key: "nodejs.org-aliyun",
    url: "https://mirrors.aliyun.com/nodejs-release/v24.16.0/node-v24.16.0-linux-x64.tar.gz",
  },
  {
    key: "nodejs.org-npmmirror",
    url: "https://cdn.npmmirror.com/binaries/node/v24.16.0/node-v24.16.0-linux-x64.tar.gz",
  },
]

for (const c of CN_MIRROR_CASES) {
  test(`assertTrustedDownload: ${c.key} accepts its real base path`, () => {
    assert.ok(
      (TRUSTED_SOURCES as Record<string, unknown>)[c.key],
      `${c.key} must be a declared trusted source`
    )
    assertTrustedDownload({
      sha256: "x",
      download: { url: c.url, trustedSource: c.key as never },
      archiveFormat: "tar.gz",
      stripComponents: 1,
      executable: "bin/node",
      binDir: "bin",
      requiredFiles: ["bin/node"],
      env: {},
    })
  })
}

test("assertTrustedDownload: CN mirror key rejects a non-matching host", () => {
  assert.throws(
    () =>
      assertTrustedDownload({
        sha256: "x",
        // ustc key but an aliyun host -> hostname not on ustc's allow-list
        download: {
          url: "https://mirrors.aliyun.com/nodejs-release/v24.16.0/node.tar.gz",
          trustedSource: "nodejs.org-ustc" as never,
        },
        archiveFormat: "tar.gz",
        stripComponents: 1,
        executable: "bin/node",
        binDir: "bin",
        requiredFiles: [],
        env: {},
      }),
    (err) => err instanceof UntrustedDownloadSourceError
  )
})
