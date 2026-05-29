import { test } from "node:test"
import assert from "node:assert/strict"

import {
  BUNDLE_ELIGIBLE_PROGRAMS,
  BUNDLE_PROGRAM_PLATFORM_KEYS,
  BUNDLE_PROGRAM_PLATFORMS,
  isBareCommandName,
  isBundleAvailableForPlatform,
  isBundleEligibleProgram,
  normalizeDevicePlatform,
  normalizeProgramName,
  programNameAliases,
} from "./commandline-normalize.js"

test("normalizeProgramName: python3 -> python, nodejs -> node, others pass through", () => {
  assert.equal(normalizeProgramName("python3"), "python")
  assert.equal(normalizeProgramName("python"), "python")
  assert.equal(normalizeProgramName("nodejs"), "node")
  assert.equal(normalizeProgramName("node"), "node")
  assert.equal(normalizeProgramName("git"), "git")
  assert.equal(normalizeProgramName("ripgrep"), "ripgrep")
})

test("programNameAliases: python returns [python, python3], node returns [node, nodejs]", () => {
  assert.deepEqual(programNameAliases("python"), ["python", "python3"])
  assert.deepEqual(programNameAliases("node"), ["node", "nodejs"])
  assert.deepEqual(programNameAliases("git"), ["git"])
  assert.deepEqual(programNameAliases("ripgrep"), ["ripgrep"])
})

test("isBareCommandName: rejects path separators, parent traversal, tilde, absolute", () => {
  assert.equal(isBareCommandName("git"), true)
  assert.equal(isBareCommandName("python3"), true)
  assert.equal(isBareCommandName("/usr/bin/git"), false)
  assert.equal(isBareCommandName(".\\bin\\git"), false)
  assert.equal(isBareCommandName("../git"), false)
  assert.equal(isBareCommandName("./git"), false)
  assert.equal(isBareCommandName("~/.local/bin/git"), false)
  assert.equal(isBareCommandName(""), false)
  assert.equal(isBareCommandName("C:\\git.exe"), false)
})

test("normalizeDevicePlatform: maps known aliases and rejects unknown", () => {
  assert.equal(normalizeDevicePlatform("win32"), "win32")
  assert.equal(normalizeDevicePlatform("Windows"), "win32")
  assert.equal(normalizeDevicePlatform("darwin"), "darwin")
  assert.equal(normalizeDevicePlatform("macOS"), "darwin")
  assert.equal(normalizeDevicePlatform("OSX"), "darwin")
  assert.equal(normalizeDevicePlatform("linux"), "linux")
  assert.equal(normalizeDevicePlatform("freebsd"), undefined)
  assert.equal(normalizeDevicePlatform(""), undefined)
  assert.equal(normalizeDevicePlatform(null), undefined)
  assert.equal(normalizeDevicePlatform(undefined), undefined)
})

test("BUNDLE_ELIGIBLE_PROGRAMS: python + node + git", () => {
  // git is bundle-eligible as of the git-for-windows MinGit integration
  // (Windows x64/arm64 only — see BUNDLE_PROGRAM_PLATFORM_KEYS.git and
  // bundles/manifest.json). Adding any other program here without a real
  // bundled asset would re-introduce the "approved but unrunnable" bug;
  // the load-time invariant in commandline-normalize.ts and the manifest
  // parity test in device-runtime catch that drift.
  assert.deepEqual([...BUNDLE_ELIGIBLE_PROGRAMS].sort(), [
    "git",
    "node",
    "python",
  ])
})

test("isBundleEligibleProgram: respects normalization (python3 ↔ python)", () => {
  assert.equal(isBundleEligibleProgram("python"), true)
  assert.equal(isBundleEligibleProgram("python3"), true)
  assert.equal(isBundleEligibleProgram("node"), true)
  assert.equal(isBundleEligibleProgram("nodejs"), true)
  assert.equal(isBundleEligibleProgram("git"), true)
  assert.equal(isBundleEligibleProgram("ripgrep"), false)
})

test("isBundleAvailableForPlatform: gates per-(platform, arch) availability strictly", () => {
  // python/node manifest entries: linux/darwin x x64/arm64; no win32.
  assert.equal(isBundleAvailableForPlatform("python", "linux", "x64"), true)
  assert.equal(isBundleAvailableForPlatform("python", "linux", "arm64"), true)
  assert.equal(isBundleAvailableForPlatform("python", "darwin", "x64"), true)
  assert.equal(isBundleAvailableForPlatform("python", "darwin", "arm64"), true)
  assert.equal(isBundleAvailableForPlatform("python", "win32", "x64"), false)
  assert.equal(isBundleAvailableForPlatform("node", "linux", "x64"), true)
  assert.equal(isBundleAvailableForPlatform("node", "win32", "x64"), false)
  // git: ONLY Windows (MinGit) — Linux/Darwin git fails closed until a
  // Synapse-built static binary is published.
  assert.equal(isBundleAvailableForPlatform("git", "win32", "x64"), true)
  assert.equal(isBundleAvailableForPlatform("git", "win32", "arm64"), true)
  assert.equal(isBundleAvailableForPlatform("git", "linux", "x64"), false)
  assert.equal(isBundleAvailableForPlatform("git", "linux", "arm64"), false)
  assert.equal(isBundleAvailableForPlatform("git", "darwin", "arm64"), false)
  // Unknown platform OR unknown arch -> STRICT false (was permissive in
  // the previous version; the change closes the local-pairing-NULL-
  // platform hole the user called out).
  assert.equal(isBundleAvailableForPlatform("python", undefined, "x64"), false)
  assert.equal(
    isBundleAvailableForPlatform("python", "linux", undefined),
    false
  )
  assert.equal(isBundleAvailableForPlatform("python", null, null), false)
  // Arch we don't bundle for (e.g. linux/ia32) -> false.
  assert.equal(isBundleAvailableForPlatform("python", "linux", "ia32"), false)
  // Not bundle-eligible at all -> always false.
  assert.equal(isBundleAvailableForPlatform("ripgrep", "linux", "x64"), false)
})

test("BUNDLE_PROGRAM_PLATFORMS: every eligible program declares its platforms", () => {
  for (const program of BUNDLE_ELIGIBLE_PROGRAMS) {
    assert.ok(
      BUNDLE_PROGRAM_PLATFORMS[program],
      `${program} missing from BUNDLE_PROGRAM_PLATFORMS`
    )
    assert.ok(
      BUNDLE_PROGRAM_PLATFORMS[program].length > 0,
      `${program} declared with zero platforms — eligible but never available`
    )
  }
})

test("BUNDLE_PROGRAM_PLATFORM_KEYS: every eligible program has a non-empty key list and well-formed entries", () => {
  // Mirrors the throw-at-import-time invariant in commandline-normalize.ts;
  // if you add a program to BUNDLE_ELIGIBLE_PROGRAMS you MUST also add at
  // least one platformKey or import will crash before any user-facing code
  // runs. This test pins the contract.
  for (const program of BUNDLE_ELIGIBLE_PROGRAMS) {
    const keys = BUNDLE_PROGRAM_PLATFORM_KEYS[program]
    assert.ok(keys, `${program} missing from BUNDLE_PROGRAM_PLATFORM_KEYS`)
    assert.ok(
      keys.length > 0,
      `${program} declared with zero platformKeys — eligible but never available`
    )
    for (const key of keys) {
      assert.match(
        key,
        /^(linux|darwin|win32)-[a-z0-9]+$/,
        `${program} platformKey "${key}" must be <platform>-<arch>`
      )
    }
  }
})

test("BUNDLE_PROGRAM_PLATFORM_KEYS: python + node both cover linux-x64, linux-arm64, darwin-x64, darwin-arm64", () => {
  // Regression guard: in an earlier draft node only covered linux-x64 +
  // darwin-arm64, leaving arm Linux servers and Intel Macs without bundle
  // fallback. Both programs must offer the full 4-key matrix until/unless
  // an entry is deliberately removed with a justifying comment.
  const REQUIRED: ReadonlyArray<`${"linux" | "darwin"}-${"x64" | "arm64"}`> = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
  ]
  for (const program of ["python", "node"] as const) {
    const keys = BUNDLE_PROGRAM_PLATFORM_KEYS[program]
    for (const required of REQUIRED) {
      assert.ok(
        keys.includes(required),
        `${program} is missing platformKey ${required} — drift between API gate and manifest`
      )
    }
  }
})

test("BUNDLE_PROGRAM_PLATFORM_KEYS: git covers Windows x64 + arm64 (MinGit), explicitly not Linux/Darwin", () => {
  // git is bundled via the official git-for-windows MinGit distribution,
  // which is Windows-only. Pin both directions:
  //   * win32-x64 + win32-arm64 MUST be in git's keys (the gate would
  //     refuse the grant otherwise).
  //   * Linux / Darwin keys MUST NOT be in git's keys — there is no
  //     canonical upstream portable Linux/Darwin git binary. Adding one
  //     requires a Synapse-built static binary first (see
  //     bundles/build-scripts/git-linux-x64.sh + bundles/manifest.
  //     production.template.json). When that lands, edit this test to
  //     allow the new keys in the same PR.
  const keys = BUNDLE_PROGRAM_PLATFORM_KEYS["git"]!
  assert.ok(keys.includes("win32-x64"), "git missing win32-x64 (MinGit x64)")
  assert.ok(
    keys.includes("win32-arm64"),
    "git missing win32-arm64 (MinGit arm64)"
  )
  for (const forbidden of [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
  ] as const) {
    assert.ok(
      !keys.includes(forbidden as never),
      `git must not declare ${forbidden} until a Synapse-built portable binary is published`
    )
  }
})
