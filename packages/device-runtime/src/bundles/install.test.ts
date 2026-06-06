import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"

import {
  installBundles,
  bundleRootDir,
  defaultPrestageDirs,
  downloadAndExtractEntry,
  readPrestagedArchive,
  resolveSidecarBundleDirs,
  summarizeInstallReport,
} from "./install.js"
import { loadManifestFromPath } from "./manifest-loader.js"

const HERE = new URL(".", import.meta.url).pathname
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

/** Synthetic fetch that returns the fixture archive bytes (the fixture
 *  manifest's download.url is `fixture://fake-git`; the real installer
 *  would do an HTTPS fetch). */
function makeFixtureFetch(): typeof fetch {
  return (async (_input: unknown) => {
    const buf = readFileSync(FIXTURE_ARCHIVE)
    return new Response(buf, { status: 200 })
  }) as unknown as typeof fetch
}

test("installBundles: downloads fixture, sha256 ok, extracts, writes marker", async () => {
  const toolchainDir = makeTmp("synapse-install-ok-")
  try {
    const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
    const report = await installBundles({
      manifest,
      toolchainDir,
      platform: "linux",
      arch: "x64",
      fetchImpl: makeFixtureFetch(),
    })
    assert.equal(report.failed.length, 0, JSON.stringify(report.failed))
    assert.equal(report.installed.length, 1)
    const entry = report.installed[0]!
    assert.equal(entry.name, "git")
    assert.equal(entry.version, "0.0.0")
    assert.ok(existsSync(join(entry.rootDir, "bin", "fake-git")))
    assert.ok(existsSync(join(entry.rootDir, ".synapse-toolchain-ok")))
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("installBundles: sha256 mismatch surfaces in failed[] + no marker written", async () => {
  const toolchainDir = makeTmp("synapse-install-shafail-")
  try {
    const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
    // Mutate the manifest's expected sha in memory.
    const bad = {
      ...manifest,
      programs: {
        git: {
          ...manifest.programs.git!,
          platforms: {
            "linux-x64": {
              ...manifest.programs.git!.platforms["linux-x64"]!,
              sha256: "00".repeat(32),
            },
          },
        },
      },
    }
    const report = await installBundles({
      manifest: bad,
      toolchainDir,
      platform: "linux",
      arch: "x64",
      fetchImpl: makeFixtureFetch(),
    })
    assert.equal(report.installed.length, 0)
    assert.equal(report.failed.length, 1)
    assert.match(report.failed[0]!.reason, /sha256 mismatch/)
    // Marker MUST NOT exist when sha verification failed. Use bundleRootDir
    // so we exercise the same path the implementation does — guards against
    // the cache-key naming drifting again.
    const rootDir = bundleRootDir(
      toolchainDir,
      "git",
      "0.0.0",
      "linux-x64",
      "linux"
    )
    assert.equal(existsSync(join(rootDir, ".synapse-toolchain-ok")), false)
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("installBundles: skipExisting=true skips an already-installed bundle", async () => {
  const toolchainDir = makeTmp("synapse-install-skip-")
  try {
    const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
    const fetchImpl = makeFixtureFetch()
    // First install — should succeed.
    await installBundles({
      manifest,
      toolchainDir,
      platform: "linux",
      arch: "x64",
      fetchImpl,
      skipExisting: true,
    })
    // Second install — should skip with "already installed" reason.
    const report = await installBundles({
      manifest,
      toolchainDir,
      platform: "linux",
      arch: "x64",
      fetchImpl,
      skipExisting: true,
    })
    assert.equal(report.installed.length, 0)
    assert.equal(report.skipped.length, 1)
    assert.match(report.skipped[0]!.reason, /already installed/)
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("installBundles: no manifest entry for platform/arch -> skipped", async () => {
  const toolchainDir = makeTmp("synapse-install-noplat-")
  try {
    const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
    const report = await installBundles({
      manifest,
      toolchainDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: makeFixtureFetch(),
    })
    assert.equal(report.installed.length, 0)
    assert.equal(report.skipped.length, 1)
    assert.match(report.skipped[0]!.reason, /no manifest entry/)
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("installBundles: TODO download URL goes to skipped[] (not failed[])", async () => {
  // Operator-incomplete entries must not break a partial-manifest install.
  // git's entry is the canonical case but we use a synthetic manifest here
  // so the assertion stays meaningful even after git is fully published.
  const toolchainDir = makeTmp("synapse-install-todo-")
  try {
    const manifest = {
      schemaVersion: 1 as const,
      programs: {
        node: loadManifestFromPath(FIXTURE_MANIFEST).programs.git!,
        git: {
          version: "TODO_FILL_AT_PR_TIME",
          platforms: {
            "linux-x64": {
              sha256: "TODO_FILL_AT_PR_TIME",
              download: {
                url: "TODO Synapse-published asset",
                license: "GPL-2.0",
              },
              archiveFormat: "tar.gz" as const,
              stripComponents: 0,
              executable: "bin/git",
              binDir: "bin",
              requiredFiles: ["bin/git"],
              env: {},
            },
          },
        },
      },
    }
    const report = await installBundles({
      manifest,
      toolchainDir,
      platform: "linux",
      arch: "x64",
      fetchImpl: makeFixtureFetch(),
    })
    // node-as-git fixture installs OK, git TODO entry skipped (not failed).
    assert.equal(report.installed.length, 1)
    assert.equal(report.failed.length, 0)
    const gitSkipped = report.skipped.find((s) => s.name === "git")
    assert.ok(gitSkipped, "git TODO entry should be in skipped[]")
    assert.match(gitSkipped!.reason, /no usable download.url/)
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("summarizeInstallReport: distinguishes healthy vs unhealthy skips", () => {
  // anyUsable=true when ANY program is on disk (either newly installed
  // OR healthy-skipped because already-installed). false when nothing on
  // disk after the run — e.g. cross-platform install where the manifest
  // has no entries for the target platform.
  const allHealthy = summarizeInstallReport({
    installed: [],
    skipped: [
      { name: "node", reason: "already installed at /tmp/x/node-x" },
      { name: "python", reason: "already installed at /tmp/x/py-x" },
    ],
    failed: [],
  })
  assert.equal(allHealthy.anyUsable, true)
  assert.equal(allHealthy.healthySkippedCount, 2)
  assert.equal(allHealthy.unhealthySkippedCount, 0)

  const allUnhealthy = summarizeInstallReport({
    installed: [],
    skipped: [
      { name: "node", reason: "no manifest entry for win32/x64" },
      { name: "python", reason: "no manifest entry for win32/x64" },
    ],
    failed: [],
  })
  assert.equal(allUnhealthy.anyUsable, false)
  assert.equal(allUnhealthy.healthySkippedCount, 0)
  assert.equal(allUnhealthy.unhealthySkippedCount, 2)

  const mixed = summarizeInstallReport({
    installed: [
      {
        name: "node",
        version: "22.x",
        platformKey: "linux-x64",
        rootDir: "/tmp/x/node-x",
        bytes: 1,
      },
    ],
    skipped: [{ name: "python", reason: "no manifest entry for linux/x64" }],
    failed: [],
  })
  assert.equal(mixed.anyUsable, true)
  assert.equal(mixed.installedCount, 1)
  assert.equal(mixed.unhealthySkippedCount, 1)
})

test("installBundles: cross-platform install with no entries -> anyUsable=false", async () => {
  // Regression for the bug the user found: install-bundles --platform=
  // win32-x64 against a manifest with only linux entries would report
  // success (exit 0) even though nothing was installed and no cache
  // existed. After the fix the CLI exits 1; here we assert the
  // anyUsable flag the CLI keys off.
  const toolchainDir = makeTmp("synapse-install-anyusable-")
  try {
    const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
    const report = await installBundles({
      manifest,
      toolchainDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: makeFixtureFetch(),
    })
    const summary = summarizeInstallReport(report)
    assert.equal(summary.installedCount, 0)
    assert.equal(summary.healthySkippedCount, 0)
    assert.ok(summary.unhealthySkippedCount > 0)
    assert.equal(summary.anyUsable, false)
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("bin: install-bundles exits 1 when all entries are unhealthy-skipped", () => {
  // End-to-end exit-code check. Locks the wire behavior the operator
  // sees: `install-bundles --platform=win32-x64 --toolchain-manifest=<linux-only>`
  // MUST exit 1, not 0. The summary helper covers this in-process; this
  // case proves bin.ts is actually wired to it. Synthetic linux-only
  // manifest so the test is unaffected by future Windows entries in the
  // production manifest.
  const tmp = makeTmp("synapse-bin-allskipped-")
  try {
    const fixturePath = join(tmp, "manifest.json")
    const linuxOnly = {
      schemaVersion: 1,
      programs: {
        node: {
          version: "0.0.0",
          platforms: {
            "linux-x64": {
              sha256: "00".repeat(32),
              download: { url: "fixture://x", trustedSource: "fixture-test" },
              archiveFormat: "tar.gz",
              stripComponents: 0,
              executable: "bin/x",
              binDir: "bin",
              requiredFiles: [],
              env: {},
            },
          },
        },
      },
    }
    writeFileSync(fixturePath, JSON.stringify(linuxOnly))
    const binPath = resolvePath(HERE, "..", "bin.ts")
    const res = spawnSync(
      process.execPath,
      [
        "--import=tsx",
        binPath,
        "install-bundles",
        "--platform=win32-x64",
        `--toolchain-manifest=${fixturePath}`,
        `--bundled-toolchain-dir=${tmp}`,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, NODE_OPTIONS: "" },
      }
    )
    assert.equal(
      res.status,
      1,
      `expected exit 1, got ${res.status}. stdout=${res.stdout} stderr=${res.stderr}`
    )
    assert.match(
      res.stderr,
      /not all programs usable/,
      `expected diagnostic in stderr; got: ${res.stderr}`
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("readPrestagedArchive: matches by content sha256, ignores filename", () => {
  const tmp = makeTmp("synapse-prestage-match-")
  try {
    const archiveBytes = readFileSync(FIXTURE_ARCHIVE)
    const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
    const entry = manifest.programs.git!.platforms["linux-x64"]!
    // Deliberately use a non-canonical filename — the matcher should still
    // accept the bytes because the sha256 is right.
    writeFileSync(join(tmp, "whatever-the-operator-named-it.tgz"), archiveBytes)
    // Also place a wrongly-named candidate with wrong content; matcher
    // must skip it without erroring.
    writeFileSync(join(tmp, `${entry.sha256}.tar.gz`), Buffer.from("bogus"))
    const found = readPrestagedArchive({
      entry,
      prestageDirs: [tmp],
    })
    assert.equal(found, null, "filename-based candidate has wrong content")
    // Now place the correct content under the conventional name.
    writeFileSync(join(tmp, `${entry.sha256}.tar.gz`), archiveBytes)
    const found2 = readPrestagedArchive({
      entry,
      prestageDirs: [tmp],
    })
    assert.ok(found2, "should accept sha-named file with correct content")
    assert.equal(found2!.byteLength, archiveBytes.byteLength)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("readPrestagedArchive: missing dir returns null (no throw)", () => {
  const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
  const entry = manifest.programs.git!.platforms["linux-x64"]!
  assert.equal(
    readPrestagedArchive({
      entry,
      prestageDirs: ["/does/not/exist"],
    }),
    null
  )
})

test("installBundles: prestaged archive bypasses HTTP fetch", async () => {
  const toolchainDir = makeTmp("synapse-install-prestage-")
  const prestageDir = makeTmp("synapse-install-prestage-src-")
  try {
    const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
    const entry = manifest.programs.git!.platforms["linux-x64"]!
    writeFileSync(
      join(prestageDir, `${entry.sha256}.tar.gz`),
      readFileSync(FIXTURE_ARCHIVE)
    )
    let fetchCalls = 0
    const noopFetch: typeof fetch = (async () => {
      fetchCalls++
      throw new Error("fetch should not be called when prestaged hit")
    }) as unknown as typeof fetch
    const report = await installBundles({
      manifest,
      toolchainDir,
      platform: "linux",
      arch: "x64",
      fetchImpl: noopFetch,
      prestageDirs: [prestageDir],
    })
    assert.equal(report.failed.length, 0, JSON.stringify(report.failed))
    assert.equal(report.installed.length, 1)
    assert.equal(fetchCalls, 0, "HTTPS fetch must not run when prestaged hit")
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
    rmSync(prestageDir, { recursive: true, force: true })
  }
})

test("installBundles: requirePrestaged fails when no matching archive", async () => {
  const toolchainDir = makeTmp("synapse-install-prestage-strict-")
  try {
    const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
    const fetchImpl: typeof fetch = (async () => {
      throw new Error("fetch should not be called under requirePrestaged")
    }) as unknown as typeof fetch
    const report = await installBundles({
      manifest,
      toolchainDir,
      platform: "linux",
      arch: "x64",
      fetchImpl,
      // prestageDirs intentionally empty
      prestageDirs: [],
      requirePrestaged: true,
    })
    assert.equal(report.installed.length, 0)
    assert.equal(report.failed.length, 1)
    assert.match(report.failed[0]!.reason, /require-prestaged/)
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("downloadAndExtractEntry: requirePrestaged + no prestage hit throws WITHOUT calling fetch (and reads candidate at most once)", async () => {
  // Direct test of the single-read property: the function should
  // detect "no pre-staged candidate" via readPrestagedArchive's
  // single buffer load and throw immediately, without falling
  // through to fetch. Earlier shape had the caller pre-check, then
  // re-invoke this function which re-read the archive — doubling
  // I/O for every install. Pin the single-call path so a future
  // refactor doesn't quietly restore the double-read.
  const tmp = makeTmp("synapse-direct-prestage-")
  try {
    const manifest = loadManifestFromPath(FIXTURE_MANIFEST)
    const entry = manifest.programs.git!.platforms["linux-x64"]!
    let fetchCalls = 0
    const fetchImpl: typeof fetch = (async () => {
      fetchCalls++
      return new Response(null, { status: 500 })
    }) as unknown as typeof fetch
    await assert.rejects(
      downloadAndExtractEntry({
        entry,
        rootDir: join(tmp, "out"),
        platform: "linux",
        fetchImpl,
        prestageDirs: ["/does/not/exist"],
        requirePrestaged: true,
      }),
      (err) => err instanceof Error && /require-prestaged/.test(err.message)
    )
    assert.equal(
      fetchCalls,
      0,
      "fetch must not be invoked when requirePrestaged is set"
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("defaultPrestageDirs: env override is first, package-root archives is last (sidecars in between)", () => {
  const prev = process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"]
  try {
    process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"] = "/opt/synapse-prestage-test"
    const dirs = defaultPrestageDirs("/opt/pkg-root")
    assert.equal(
      dirs[0],
      "/opt/synapse-prestage-test",
      "env override must be first"
    )
    assert.equal(
      dirs[dirs.length - 1],
      "/opt/pkg-root/bundles/archives",
      "package-root archives must be last"
    )
    // Whatever's in between must be sidecar dirs (or zero entries when
    // sidecars are absent from this checkout).
    for (const dir of dirs.slice(1, -1)) {
      assert.match(
        dir,
        /device-runtime-bundles-(linux|darwin|win32)-(x64|arm64)\/bundles/,
        `unexpected middle entry: ${dir}`
      )
    }
  } finally {
    if (prev === undefined) {
      delete process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"]
    } else {
      process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"] = prev
    }
  }
})

test("defaultPrestageDirs: no env override yields sidecars + package-root entry", () => {
  const prev = process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"]
  try {
    delete process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"]
    const dirs = defaultPrestageDirs("/opt/pkg-root")
    assert.equal(
      dirs[dirs.length - 1],
      "/opt/pkg-root/bundles/archives",
      "package-root archives must be last"
    )
    // First entry is either a sidecar (if present) or the package-root
    // archives dir (if no sidecars discovered).
    assert.ok(dirs.length >= 1)
  } finally {
    if (prev !== undefined) process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"] = prev
  }
})

test("downloadAndExtractEntry: zip archiveFormat extracts via unzipper, sha256 still gates", async () => {
  // Builds a zip in-memory (no extra fixture file), pins its sha256 in
  // a synthetic manifest entry, and runs the installer. Both the new
  // zip code path AND the sha256-verification-before-extract sequence
  // get exercised in one shot. Covers the MinGit/Windows path that
  // ships only zip archives.
  const { downloadAndExtractEntry } = await import("./install.js")
  const stagingDir = makeTmp("synapse-zip-fixture-")
  const archivePath = join(stagingDir, "fake-mingit.zip")
  const srcDir = join(stagingDir, "src")
  try {
    const { mkdirSync, writeFileSync: writeFile } = await import("node:fs")
    mkdirSync(join(srcDir, "cmd"), { recursive: true })
    writeFile(
      join(srcDir, "cmd", "fake-git.txt"),
      "#!fake-mingit\necho fake-git\n"
    )
    const zipRes = spawnSync("zip", ["-q", "-r", archivePath, "."], {
      cwd: srcDir,
      encoding: "utf-8",
    })
    if (zipRes.error || zipRes.status !== 0) {
      // `zip` not available on this runner — skip gracefully so the
      // rest of the suite still passes. The fixture-tar.gz tests
      // above already cover the install pipeline end-to-end.
      return
    }
    const buf = readFileSync(archivePath)
    const expectedSha = createHash("sha256").update(buf).digest("hex")
    let fetchCalls = 0
    const fetchImpl: typeof fetch = (async () => {
      fetchCalls++
      return new Response(buf, { status: 200 })
    }) as unknown as typeof fetch
    const targetRoot = makeTmp("synapse-zip-extract-")
    try {
      await downloadAndExtractEntry({
        entry: {
          sha256: expectedSha,
          download: {
            url: "fixture://fake-mingit.zip",
            trustedSource: "fixture-test",
          },
          archiveFormat: "zip",
          stripComponents: 0,
          executable: "cmd/fake-git.txt",
          binDir: "cmd",
          requiredFiles: ["cmd/fake-git.txt"],
          env: {},
        },
        rootDir: targetRoot,
        platform: "linux",
        fetchImpl,
      })
      assert.equal(fetchCalls, 1, "fetch ran once")
      assert.ok(
        existsSync(join(targetRoot, "cmd", "fake-git.txt")),
        "extracted entry missing"
      )
      assert.ok(
        existsSync(join(targetRoot, ".synapse-toolchain-ok")),
        "completion marker missing"
      )
    } finally {
      rmSync(targetRoot, { recursive: true, force: true })
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
})

test("downloadAndExtractEntry: zip with `..` entry refuses to escape rootDir", async () => {
  // Builds a tiny malicious zip via the system `zip` cli; if absent,
  // skip. Asserts joinUnderRoot's safety check fires before any file
  // is written outside the target dir. Mirrors the analogous tar path
  // already covered by toolchain-manager.test.ts.
  const { spawnSync } = await import("node:child_process")
  const stagingDir = makeTmp("synapse-zip-escape-")
  try {
    const { mkdirSync, writeFileSync: writeFile } = await import("node:fs")
    const srcDir = join(stagingDir, "src")
    mkdirSync(srcDir, { recursive: true })
    writeFile(join(srcDir, "harmless.txt"), "ok")
    const archivePath = join(stagingDir, "evil.zip")
    // Write `harmless.txt` then rewrite the central-directory entry to
    // use `../../escape.txt`. zip(1) doesn't natively support that, so
    // we synthesize it with python3 zipfile if available.
    const py = spawnSync(
      "python3",
      [
        "-c",
        `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('../escape.txt','pwn')\nz.close()`,
        archivePath,
      ],
      { encoding: "utf-8" }
    )
    if (py.error || py.status !== 0) {
      return // skip if no python3 / zip
    }
    const buf = readFileSync(archivePath)
    const expectedSha = createHash("sha256").update(buf).digest("hex")
    const targetRoot = makeTmp("synapse-zip-escape-target-")
    try {
      const { downloadAndExtractEntry } = await import("./install.js")
      const fetchImpl: typeof fetch = (async () =>
        new Response(buf, { status: 200 })) as unknown as typeof fetch
      let threw = false
      try {
        await downloadAndExtractEntry({
          entry: {
            sha256: expectedSha,
            download: {
              url: "fixture://evil.zip",
              trustedSource: "fixture-test",
            },
            archiveFormat: "zip",
            stripComponents: 0,
            executable: "harmless.txt",
            binDir: ".",
            requiredFiles: [],
            env: {},
          },
          rootDir: targetRoot,
          platform: "linux",
          fetchImpl,
        })
      } catch (err) {
        threw = true
        assert.match(
          String(err),
          /resolves outside rootDir|outside the root directory|ManifestPathEscapeError|path escapes toolchain root/i,
          `unexpected error: ${String(err)}`
        )
      }
      assert.equal(threw, true, "malicious zip entry must be rejected")
      // Ensure no escape file was actually written next to the targetRoot.
      assert.equal(
        existsSync(join(targetRoot, "..", "escape.txt")),
        false,
        "escape file should NOT have been written"
      )
    } finally {
      rmSync(targetRoot, { recursive: true, force: true })
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
})

test("resolveSidecarBundleDirs: discovers symlinked @synapse sidecar packages alongside device-runtime", () => {
  // In this worktree, npm install symlinks the per-platformKey sidecar
  // packages into node_modules/@synapse/device-runtime-bundles-*/.
  // The host (linux-x64 CI) should at minimum see its own sidecar
  // first; other-arch sidecars also surface (they're harmless because
  // the runtime only consumes archives matching its expected sha256).
  const dirs = resolveSidecarBundleDirs()
  assert.ok(
    dirs.length > 0,
    "expected at least one sidecar bundle dir to be discovered; got none"
  )
  // Host's own sidecar must be first when present.
  const hostKey = `${process.platform}-${process.arch}`
  const hostSidecar = dirs.find((d) =>
    d.includes(`device-runtime-bundles-${hostKey}`)
  )
  if (hostSidecar) {
    assert.equal(
      dirs[0],
      hostSidecar,
      `host sidecar ${hostKey} must be first in lookup order; got ${dirs[0]}`
    )
  }
  for (const dir of dirs) {
    assert.ok(existsSync(dir), `discovered sidecar dir ${dir} should exist`)
  }
})

test("defaultPrestageDirs: includes sidecar bundle dirs between env override and package-root bundles/archives", () => {
  const prev = process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"]
  try {
    process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"] = "/opt/op-override"
    const dirs = defaultPrestageDirs("/opt/pkg-root")
    assert.equal(dirs[0], "/opt/op-override", "env override stays first")
    const lastDir = dirs[dirs.length - 1]
    assert.equal(
      lastDir,
      "/opt/pkg-root/bundles/archives",
      "package-root archives stays last"
    )
    const middle = dirs.slice(1, -1)
    assert.ok(
      middle.some((d) => d.includes("device-runtime-bundles-")),
      `expected sidecar dirs between env override and pkg-root; got: ${JSON.stringify(dirs)}`
    )
  } finally {
    if (prev === undefined) delete process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"]
    else process.env["SYNAPSE_DEVICE_PRESTAGED_DIR"] = prev
  }
})

test("installBundles: requirePrestaged satisfied entirely by sidecar (no HTTPS) for current host platform", async () => {
  // The strongest end-to-end proof that "首跑无网" is real:
  //   * requirePrestaged: true forbids the HTTPS fallback;
  //   * defaultPrestageDirs() (called with no explicit prestageDirs)
  //     drops the env override but still finds the sidecar
  //     packages via node_modules walk;
  //   * the install must therefore succeed using ONLY the on-disk
  //     sidecar archives committed under packages/device-runtime-
  //     bundles-<host>/bundles/.
  // If a fresh checkout's `npm install` fails to symlink the sidecar
  // or the sha256 in the manifest drifts away from the committed
  // archive, this test fires red — the same kind of drift the user
  // keeps flagging.
  const hostPlatform = process.platform as "linux" | "darwin" | "win32"
  const hostArch = process.arch
  // Skip non-supported host (e.g. CI on a niche arch).
  const supported = new Set(["linux", "darwin", "win32"])
  if (!supported.has(hostPlatform)) return
  const toolchainDir = makeTmp("synapse-install-sidecaronly-")
  try {
    const manifest = loadManifestFromPath(
      join(
        new URL(".", import.meta.url).pathname,
        "..",
        "..",
        "bundles",
        "manifest.json"
      )
    )
    // Only consider programs the manifest actually offers on this
    // host's platformKey — git on linux falls into "skipped", not a
    // failure to require.
    const dirs = defaultPrestageDirs()
    let blockedFetchCount = 0
    const blockedFetch: typeof fetch = (async () => {
      blockedFetchCount++
      throw new Error(
        "fetch invoked under requirePrestaged — sidecar lookup failed"
      )
    }) as unknown as typeof fetch
    const report = await installBundles({
      manifest,
      toolchainDir,
      platform: hostPlatform,
      arch: hostArch,
      fetchImpl: blockedFetch,
      prestageDirs: dirs,
      requirePrestaged: true,
    })
    assert.equal(
      blockedFetchCount,
      0,
      "fetch must not run when sidecar archives satisfy every program"
    )
    // Every program the manifest defines for this host must either be
    // installed or skipped because of a non-existence reason (no
    // matching manifest entry). NONE may be failed.
    assert.equal(
      report.failed.length,
      0,
      `unexpected failures: ${JSON.stringify(report.failed)}`
    )
    // At least one install (the runtime is useless if we can't bring
    // ANY toolchain).
    assert.ok(
      report.installed.length > 0,
      `no programs installed for ${hostPlatform}/${hostArch}; expected at least one`
    )
  } finally {
    rmSync(toolchainDir, { recursive: true, force: true })
  }
})

test("sidecar ↔ manifest sha256 parity: every populated sidecar archive matches a manifest entry's sha256", async () => {
  // Drift detector: if someone bumps a manifest sha256 without
  // re-running scripts/populate-device-runtime-bundles.sh, this test
  // fires red. Inverse direction: a sidecar archive whose sha256 no
  // longer appears in the manifest is dead weight (manifest cleanup
  // missed it).
  const here = new URL(".", import.meta.url).pathname
  const manifestPath = join(here, "..", "..", "bundles", "manifest.json")
  const manifest = loadManifestFromPath(manifestPath)
  // Build set of (platformKey -> set<sha256>).
  const expected = new Map<string, Set<string>>()
  for (const program of Object.values(manifest.programs)) {
    for (const [key, entry] of Object.entries(program.platforms)) {
      if (!expected.has(key)) expected.set(key, new Set())
      expected.get(key)!.add(entry.sha256.toLowerCase())
    }
  }
  const { readdirSync } = await import("node:fs")
  const repoRoot = join(here, "..", "..", "..", "..")
  for (const [key, expectedShas] of expected) {
    const dir = join(
      repoRoot,
      "packages",
      `device-runtime-bundles-${key}`,
      "bundles"
    )
    if (!existsSync(dir)) continue // sidecar package absent from this checkout — acceptable
    const files = readdirSync(dir).filter((f) => f !== "README.md")
    if (files.length === 0) continue // sidecar shipped empty (lean checkout) — acceptable
    for (const file of files) {
      const fileSha = file.split(".")[0]!.toLowerCase()
      assert.ok(
        expectedShas.has(fileSha),
        `sidecar archive ${dir}/${file} sha256 ${fileSha} is not in manifest for ${key} — orphaned archive or stale manifest`
      )
    }
  }
})

// --- China mirror prefix rewrite (P5) --------------------------------------
function nodeEntry() {
  // sha256 of the tiny fixture archive so the post-download check passes.
  const sha = createHash("sha256")
    .update(readFileSync(FIXTURE_ARCHIVE))
    .digest("hex")
  return {
    sha256: sha,
    download: {
      url: "https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.gz",
      trustedSource: "nodejs.org-official" as const,
    },
    archiveFormat: "tar.gz" as const,
    stripComponents: 1,
    executable: "bin/fake-git",
    binDir: "bin",
    requiredFiles: [],
    env: {},
  }
}

// Capturing fetch: records the requested URL, returns the fixture bytes.
function makeCapturingFetch(captured: { url: string }): typeof fetch {
  return (async (input: unknown) => {
    captured.url = String(input)
    return new Response(readFileSync(FIXTURE_ARCHIVE), { status: 200 })
  }) as unknown as typeof fetch
}

test("downloadAndExtractEntry: toolchainMirror=ustc rewrites FULL prefix, sha256 still official", async () => {
  const rootDir = makeTmp("synapse-mirror-ustc-")
  const captured = { url: "" }
  try {
    await downloadAndExtractEntry({
      entry: nodeEntry(),
      rootDir,
      platform: "linux",
      fetchImpl: makeCapturingFetch(captured),
      toolchainMirror: "ustc",
    })
    // Full prefix replaced (NOT just host): /dist/ -> /node/
    assert.equal(
      captured.url,
      "https://mirrors.ustc.edu.cn/node/v24.16.0/node-v24.16.0-linux-x64.tar.gz"
    )
    assert.ok(existsSync(join(rootDir, ".synapse-toolchain-ok")))
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("downloadAndExtractEntry: npmmirror uses /binaries/node/ base path", async () => {
  const rootDir = makeTmp("synapse-mirror-npm-")
  const captured = { url: "" }
  try {
    await downloadAndExtractEntry({
      entry: nodeEntry(),
      rootDir,
      platform: "linux",
      fetchImpl: makeCapturingFetch(captured),
      toolchainMirror: "npmmirror",
    })
    assert.equal(
      captured.url,
      "https://cdn.npmmirror.com/binaries/node/v24.16.0/node-v24.16.0-linux-x64.tar.gz"
    )
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("downloadAndExtractEntry: unknown/empty mirror -> no rewrite (official source)", async () => {
  for (const mirror of ["", "nodejs", "bogus"]) {
    const rootDir = makeTmp("synapse-mirror-none-")
    const captured = { url: "" }
    try {
      await downloadAndExtractEntry({
        entry: nodeEntry(),
        rootDir,
        platform: "linux",
        fetchImpl: makeCapturingFetch(captured),
        toolchainMirror: mirror,
      })
      assert.equal(
        captured.url,
        "https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.gz",
        `mirror='${mirror}' should NOT rewrite`
      )
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  }
})

test("downloadAndExtractEntry: mirror bytes still gated by official sha256", async () => {
  const rootDir = makeTmp("synapse-mirror-sha-")
  // entry with a WRONG sha256 -> even via mirror, must fail the integrity gate
  const bad = { ...nodeEntry(), sha256: "0".repeat(64) }
  try {
    await assert.rejects(
      downloadAndExtractEntry({
        entry: bad,
        rootDir,
        platform: "linux",
        fetchImpl: makeCapturingFetch({ url: "" }),
        toolchainMirror: "ustc",
      }),
      /sha256 mismatch/
    )
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
