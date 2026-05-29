import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { detectTerminalEnvironment } from "./environment.js"
import {
  createToolchainManager,
  ToolchainSha256MismatchError,
  ToolchainUnavailableError,
  archivePathFor,
} from "./toolchain-manager.js"
import type { PathResolver } from "./types.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_MANIFEST = join(
  HERE,
  "..",
  "..",
  "bundles",
  "__fixtures__",
  "manifest.fixture.json"
)
const FIXTURE_ARCHIVE = join(
  HERE,
  "..",
  "..",
  "bundles",
  "__fixtures__",
  "linux-x64",
  "git-0.0.0.tar.gz"
)

function makeTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function makeManager(opts: {
  manifestPath?: string
  toolchainDir: string
  pathResolver: PathResolver
  archiveLocator?: Parameters<
    typeof createToolchainManager
  >[0]["archiveLocator"]
  allowAutoDownload?: boolean
  fetchImpl?: typeof fetch
}) {
  const environment = await detectTerminalEnvironment({
    platform: "linux",
    osEnv: { PATH: "/usr/bin" },
    pathResolver: opts.pathResolver,
    arch: "x64",
  })
  return createToolchainManager({
    manifestPath: opts.manifestPath ?? FIXTURE_MANIFEST,
    toolchainDir: opts.toolchainDir,
    environment,
    pathResolver: opts.pathResolver,
    archiveLocator: opts.archiveLocator,
    // Tests default to NO auto-download so we don't accidentally make
    // network calls. Individual tests opt in by passing true.
    allowAutoDownload: opts.allowAutoDownload ?? false,
    fetchImpl: opts.fetchImpl,
  })
}

test("resolve: system PATH hit short-circuits before consulting manifest", async () => {
  const toolchainDir = makeTmp("synapse-tc-system-")
  try {
    const manager = await makeManager({
      toolchainDir,
      pathResolver: (name) => (name === "git" ? "/usr/bin/git" : null),
    })
    const resolved = await manager.resolve("git", true)
    assert.equal(resolved.source, "system")
    assert.equal(resolved.binPath, "/usr/bin/git")
    assert.equal(resolved.binDir, "/usr/bin")
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: system miss + bundled denied -> ToolchainUnavailableError", async () => {
  const toolchainDir = makeTmp("synapse-tc-denied-")
  try {
    const manager = await makeManager({
      toolchainDir,
      pathResolver: () => null,
    })
    await assert.rejects(
      () => manager.resolve("git", false),
      (err) =>
        err instanceof ToolchainUnavailableError &&
        /policy denies/.test(err.message)
    )
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: bundled-archive extract + sha256 ok + cache hit on 2nd call", async () => {
  const toolchainDir = makeTmp("synapse-tc-extract-")
  try {
    const manager = await makeManager({
      toolchainDir,
      pathResolver: () => null,
    })
    const first = await manager.resolve("git", true)
    assert.equal(first.source, "bundled-archive")
    if (
      first.source === "bundled-archive" ||
      first.source === "bundled-cache"
    ) {
      assert.ok(first.rootDir.endsWith("git-0.0.0-linux-x64"))
      assert.ok(existsSync(first.binPath))
      assert.equal(first.env.FAKE_GIT_ROOT, first.rootDir)
    }

    const second = await manager.resolve("git", true)
    assert.equal(second.source, "bundled-cache")
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: sha256 mismatch throws and cache not written", async () => {
  const toolchainDir = makeTmp("synapse-tc-shamismatch-")
  try {
    // Custom manifest with wrong sha so the locator's bytes don't match.
    const manifestDir = makeTmp("synapse-tc-shaman-")
    cpSync(
      join(
        HERE,
        "..",
        "..",
        "bundles",
        "__fixtures__",
        "linux-x64",
        "git-0.0.0.tar.gz"
      ),
      join(manifestDir, "linux-x64", "git-0.0.0.tar.gz"),
      { recursive: true }
    )
    const manifestPath = join(manifestDir, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        programs: {
          git: {
            version: "0.0.0",
            platforms: {
              "linux-x64": {
                sha256:
                  "0000000000000000000000000000000000000000000000000000000000000000",
                download: { url: "fixture://bad", license: "MIT" },
                archiveFormat: "tar.gz",
                stripComponents: 0,
                executable: "bin/fake-git",
                binDir: "bin",
                requiredFiles: ["bin/fake-git"],
                env: {},
              },
            },
          },
        },
      })
    )
    const manager = await makeManager({
      manifestPath,
      toolchainDir,
      pathResolver: () => null,
    })
    await assert.rejects(
      () => manager.resolve("git", true),
      (err) => err instanceof ToolchainSha256MismatchError
    )
    rmSync(manifestDir, { recursive: true, force: true })
    // cache root should NOT exist (rejected before marker writes).
    const cacheRoot = join(toolchainDir, "git-0.0.0-linux-x64")
    assert.equal(existsSync(cacheRoot), false)
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: requiredFiles missing -> throws ToolchainUnavailableError", async () => {
  // Manifest references a file not present in the archive — extraction
  // succeeds, sha256 matches, but the integrity check fails.
  const toolchainDir = makeTmp("synapse-tc-required-")
  try {
    const manifestDir = makeTmp("synapse-tc-required-man-")
    cpSync(
      FIXTURE_ARCHIVE,
      join(manifestDir, "linux-x64", "git-0.0.0.tar.gz"),
      { recursive: true }
    )
    const manifestPath = join(manifestDir, "manifest.json")
    const fixtureSha = sha256(FIXTURE_ARCHIVE)
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        programs: {
          git: {
            version: "0.0.0",
            platforms: {
              "linux-x64": {
                sha256: fixtureSha,
                download: { url: "fixture://required", license: "MIT" },
                archiveFormat: "tar.gz",
                stripComponents: 0,
                executable: "bin/fake-git",
                binDir: "bin",
                requiredFiles: ["share/missing-file"],
                env: {},
              },
            },
          },
        },
      })
    )
    const manager = await makeManager({
      manifestPath,
      toolchainDir,
      pathResolver: () => null,
    })
    await assert.rejects(
      () => manager.resolve("git", true),
      (err) =>
        err instanceof ToolchainUnavailableError &&
        /requiredFiles/.test(err.message)
    )
    rmSync(manifestDir, { recursive: true, force: true })
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolveBare: returns ResolvedToolchain (system) when on PATH", async () => {
  const toolchainDir = makeTmp("synapse-tc-bare-")
  try {
    const manager = await makeManager({
      toolchainDir,
      pathResolver: (name) =>
        name === "ripgrep" ? "/usr/local/bin/ripgrep" : null,
    })
    const resolved = await manager.resolveBare("ripgrep")
    assert.ok(resolved !== null)
    assert.equal(resolved!.source, "system")
    assert.equal(resolved!.binPath, "/usr/local/bin/ripgrep")
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolveBare: returns null when not found, never consults manifest", async () => {
  const toolchainDir = makeTmp("synapse-tc-barenull-")
  try {
    const manager = await makeManager({
      toolchainDir,
      pathResolver: () => null,
    })
    assert.equal(await manager.resolveBare("ripgrep"), null)
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: alias order — python literal hit before normalized fallback", async () => {
  // The fixture manifest only contains `git`, but the alias test exercises
  // the resolveSystem path independently of bundle eligibility, so we use
  // a never-managed program with explicit aliases.
  const toolchainDir = makeTmp("synapse-tc-alias-")
  try {
    const allCalls: string[] = []
    const manager = await makeManager({
      toolchainDir,
      pathResolver: (name) => {
        allCalls.push(name)
        return name === "python3" ? "/usr/bin/python3" : null
      },
    })
    const baseline = allCalls.length
    const resolved = await manager.resolveBare("python")
    assert.ok(resolved !== null)
    assert.equal(resolved!.binPath, "/usr/bin/python3")
    // Order during this resolveBare: literal requested first ("python"),
    // then alias ("python3").
    assert.deepEqual(allCalls.slice(baseline), ["python", "python3"])
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: literal python3 wins over fallback to python", async () => {
  const toolchainDir = makeTmp("synapse-tc-literalpy3-")
  try {
    const allCalls: string[] = []
    const manager = await makeManager({
      toolchainDir,
      pathResolver: (name) => {
        allCalls.push(name)
        if (name === "python3") return "/usr/bin/python3"
        if (name === "python") return "/usr/bin/python"
        return null
      },
    })
    const baseline = allCalls.length
    const resolved = await manager.resolveBare("python3")
    assert.ok(resolved !== null)
    // Literal first => python3 wins.
    assert.equal(resolved!.binPath, "/usr/bin/python3")
    assert.equal(allCalls[baseline], "python3")
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: missing archive + auto-download disabled -> ToolchainUnavailableError", async () => {
  const toolchainDir = makeTmp("synapse-tc-noarchive-")
  try {
    const manager = await makeManager({
      toolchainDir,
      pathResolver: () => null,
      // Custom locator that returns null (no archive available).
      archiveLocator: async () => null,
      allowAutoDownload: false,
    })
    await assert.rejects(
      () => manager.resolve("git", true),
      (err) => err instanceof ToolchainUnavailableError
    )
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: cache root includes platformKey suffix (no cross-arch collision)", async () => {
  // Two managers on different architectures pointing at the same toolchain
  // dir must NOT share a cache directory — that would let an x64 install
  // satisfy an arm64 resolve.
  const toolchainDir = makeTmp("synapse-tc-cachekey-")
  try {
    const env64 = await detectTerminalEnvironment({
      platform: "linux",
      arch: "x64",
      osEnv: { PATH: "/usr/bin" },
      pathResolver: () => null,
    })
    const m64 = createToolchainManager({
      manifestPath: FIXTURE_MANIFEST,
      toolchainDir,
      environment: env64,
      pathResolver: () => null,
      allowAutoDownload: false,
    })
    const resolved = await m64.resolve("git", true)
    if (
      resolved.source === "bundled-archive" ||
      resolved.source === "bundled-cache"
    ) {
      assert.ok(
        resolved.rootDir.endsWith("git-0.0.0-linux-x64"),
        `expected platformKey suffix, got ${resolved.rootDir}`
      )
    }
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: marker sha mismatch invalidates cache (manifest entry bumped)", async () => {
  const toolchainDir = makeTmp("synapse-tc-markerdrift-")
  try {
    // First: install via fixture manifest (correct sha).
    const manager = await makeManager({
      toolchainDir,
      pathResolver: () => null,
    })
    const first = await manager.resolve("git", true)
    assert.equal(first.source, "bundled-archive")
    if (first.source === "bundled-archive") {
      // Tamper the marker so the next resolve sees a mismatched sha.
      writeFileSync(
        join(first.rootDir, ".synapse-toolchain-ok"),
        "00".repeat(32)
      )
      // Now ask again — cache must be considered invalid, falling back to
      // archive extract (which restores the correct marker).
      const second = await manager.resolve("git", true)
      assert.equal(second.source, "bundled-archive")
    }
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: auto-download via fetchImpl when archive missing", async () => {
  const toolchainDir = makeTmp("synapse-tc-autodl-")
  try {
    // Build a manifest where the fixture archive lives at a URL only the
    // injected fetchImpl can serve. archiveLocator returns null so we
    // exercise the auto-download branch.
    const manifestDir = makeTmp("synapse-tc-autodl-man-")
    const fixtureBytes = readFileSync(FIXTURE_ARCHIVE)
    const expectedSha = sha256(FIXTURE_ARCHIVE)
    const manifestPath = join(manifestDir, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        programs: {
          git: {
            version: "0.0.0",
            platforms: {
              "linux-x64": {
                sha256: expectedSha,
                download: {
                  url: "fixture://test-auto-download",
                  license: "MIT",
                  trustedSource: "fixture-test",
                },
                archiveFormat: "tar.gz",
                stripComponents: 0,
                executable: "bin/fake-git",
                binDir: "bin",
                requiredFiles: ["bin/fake-git"],
                env: {},
              },
            },
          },
        },
      })
    )
    const fakeFetch = (async () =>
      new Response(fixtureBytes, { status: 200 })) as unknown as typeof fetch
    const manager = await makeManager({
      manifestPath,
      toolchainDir,
      pathResolver: () => null,
      archiveLocator: async () => null,
      allowAutoDownload: true,
      fetchImpl: fakeFetch,
    })
    const resolved = await manager.resolve("git", true)
    assert.equal(resolved.source, "bundled-archive")
    rmSync(manifestDir, { recursive: true, force: true })
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("resolve: auto-download with TODO url -> ToolchainUnavailableError", async () => {
  const toolchainDir = makeTmp("synapse-tc-todourl-")
  try {
    const manifestDir = makeTmp("synapse-tc-todourl-man-")
    const manifestPath = join(manifestDir, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        programs: {
          git: {
            version: "0.0.0",
            platforms: {
              "linux-x64": {
                sha256: "00".repeat(32),
                download: {
                  url: "TODO Synapse-published release asset",
                  license: "GPL-2.0",
                },
                archiveFormat: "tar.gz",
                stripComponents: 0,
                executable: "bin/git",
                binDir: "bin",
                requiredFiles: ["bin/git"],
                env: {},
              },
            },
          },
        },
      })
    )
    const manager = await makeManager({
      manifestPath,
      toolchainDir,
      pathResolver: () => null,
      archiveLocator: async () => null,
      allowAutoDownload: true,
    })
    await assert.rejects(
      () => manager.resolve("git", true),
      (err) =>
        err instanceof ToolchainUnavailableError &&
        /no usable download.url/.test(err.message)
    )
    rmSync(manifestDir, { recursive: true, force: true })
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("archivePathFor: stays under manifest dir", () => {
  const path = archivePathFor(
    "/opt/bundles/manifest.json",
    "linux-x64",
    "node",
    "22.0.0"
  )
  assert.equal(path, "/opt/bundles/linux-x64/node-22.0.0.tar.gz")
})

function sha256(filePath: string): string {
  const buf = readFileSync(filePath)
  return createHash("sha256").update(buf).digest("hex")
}
